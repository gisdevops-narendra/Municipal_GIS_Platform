import { BadRequestException, Injectable } from '@nestjs/common';
import PdfPrinter from 'pdfmake';
import type {
  Content,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { GisLayersService } from './gis-layers.service';
import { GeoServerService } from './geoserver.service';
import { assertSafeCql } from './cql-guard';
import { LayerReportDto, REPORT_MAX_ROWS } from './dto/layer-report.dto';
import type { AttributeInfo } from './field-stats.service';

/** PDF's 14 standard fonts — no font files to ship. They cover Latin text
 *  only (WinAnsi); other scripts would need an embedded TTF. */
const FONTS = {
  Helvetica: {
    normal: 'Helvetica',
    bold: 'Helvetica-Bold',
    italics: 'Helvetica-Oblique',
    bolditalics: 'Helvetica-BoldOblique',
  },
};

const INK = '#1b2a26';
const MUTED = '#5b6b63';
const RULE = '#d8ddd8';
const ZEBRA = '#f3f6f4';
const ACCENT = '#0d9488';

interface FieldStat {
  name: string;
  numeric: boolean;
  withValue: number;
  distinct: number;
  min?: number;
  max?: number;
  mean?: number;
  sum?: number;
}

/**
 * Report Generation — a layer data report as a PDF: title, details (layer,
 * department, scope, row count), per-field summary statistics, and the
 * feature table. Data comes from GeoServer server-side for the requested
 * columns only; the caller needs VIEW on the layer, a client filter must
 * pass assertSafeCql, and selected ids must belong to the layer.
 */
@Injectable()
export class LayerReportService {
  private readonly printer = new PdfPrinter(FONTS);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gisLayers: GisLayersService,
    private readonly geoServer: GeoServerService,
  ) {}

  async buildReport(
    appUser: AppUser,
    layerId: string,
    dto: LayerReportDto,
  ): Promise<{ filename: string; body: Buffer }> {
    const { layer, attributes } = await this.gisLayers.reportSource(
      appUser,
      layerId,
    );
    const fields = this.resolveFields(dto.fields, attributes);
    const scope = this.resolveScope(dto, layer.geoserverLayer);

    const { features, numberMatched } =
      await this.geoServer.getFeatureCollection(
        layer.geoserverWorkspace,
        layer.geoserverLayer,
        {
          propertyNames: fields.map((f) => f.name),
          cqlFilter: scope.cqlFilter,
          featureIds: scope.featureIds,
          count: REPORT_MAX_ROWS,
        },
      );
    const rows = features.map((f) => f.properties ?? {});

    const [user, municipality] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: appUser.id },
        select: { fullName: true },
      }),
      this.prisma.municipality.findUnique({
        where: { id: appUser.municipalityId },
        select: { name: true },
      }),
    ]);

    const generatedAt = new Date();
    const doc = this.documentDefinition({
      title: dto.title?.trim() || `${layer.name} report`,
      municipality: municipality?.name ?? '',
      generatedBy: user?.fullName ?? '',
      generatedAt,
      details: [
        ['Layer', layer.name],
        [
          'Ownership',
          layer.ownershipType === 'CANONICAL'
            ? 'Municipality-wide (canonical)'
            : `Department — ${layer.department?.name ?? '—'}`,
        ],
        ['Geometry', layer.geometryType ?? '—'],
        ['Scope', scope.label],
        [
          'Features in report',
          numberMatched > rows.length
            ? `First ${fmt(rows.length)} of ${fmt(numberMatched)} (report limit)`
            : fmt(rows.length),
        ],
      ],
      fields,
      stats: this.fieldStats(fields, rows),
      rows,
    });

    const stamp = generatedAt.toISOString().slice(0, 10).replace(/-/g, '');
    return {
      filename: `${layer.code.toLowerCase()}-report-${stamp}.pdf`,
      body: await this.render(doc),
    };
  }

  private resolveFields(
    requested: string[],
    attributes: AttributeInfo[],
  ): AttributeInfo[] {
    const byName = new Map(attributes.map((a) => [a.name, a]));
    const fields = [...new Set(requested)].map((name) => {
      const field = byName.get(name);
      if (!field) {
        throw new BadRequestException(
          `"${name}" is not an attribute of this layer.`,
        );
      }
      return field;
    });
    return fields;
  }

  private resolveScope(
    dto: LayerReportDto,
    geoserverLayer: string,
  ): { label: string; cqlFilter?: string; featureIds?: string[] } {
    if (dto.scope === 'query') {
      const cql = dto.cqlFilter?.trim();
      if (!cql) {
        throw new BadRequestException('A query report needs a filter.');
      }
      assertSafeCql(cql);
      return {
        label: `Filtered — ${dto.scopeLabel?.trim() || 'current query'}`,
        cqlFilter: cql,
      };
    }
    if (dto.scope === 'selection') {
      const ids = [...new Set(dto.featureIds ?? [])];
      if (ids.length === 0) {
        throw new BadRequestException('Select at least one feature.');
      }
      // WFS featureID can name ANY feature type ("other.5") — only this
      // layer's own ids are accepted.
      const prefix = `${geoserverLayer}.`;
      if (ids.some((id) => !id.startsWith(prefix) || !/^[\w.-]+$/.test(id))) {
        throw new BadRequestException(
          'Selected features must belong to this layer.',
        );
      }
      return {
        label: `Selected features (${fmt(ids.length)})`,
        featureIds: ids,
      };
    }
    return { label: 'Whole layer' };
  }

  private fieldStats(
    fields: AttributeInfo[],
    rows: Record<string, unknown>[],
  ): FieldStat[] {
    return fields.map((field) => {
      const values = rows
        .map((r) => r[field.name])
        .filter((v) => v !== null && v !== undefined && v !== '');
      const stat: FieldStat = {
        name: field.name,
        numeric: field.kind === 'number',
        withValue: values.length,
        distinct: new Set(values.map((v) => String(v))).size,
      };
      if (stat.numeric) {
        const numbers = values.map(Number).filter(Number.isFinite);
        if (numbers.length) {
          const sum = numbers.reduce((a, b) => a + b, 0);
          stat.min = Math.min(...numbers);
          stat.max = Math.max(...numbers);
          stat.sum = sum;
          stat.mean = sum / numbers.length;
        }
      }
      return stat;
    });
  }

  private documentDefinition(input: {
    title: string;
    municipality: string;
    generatedBy: string;
    generatedAt: Date;
    details: [string, string][];
    fields: AttributeInfo[];
    stats: FieldStat[];
    rows: Record<string, unknown>[];
  }): TDocumentDefinitions {
    const wide = input.fields.length > 5;
    const generated = input.generatedAt.toLocaleString('en-IN', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'Asia/Kolkata',
    });

    const th = (
      text: string,
      alignment: 'left' | 'right' = 'left',
    ): TableCell => ({
      text,
      bold: true,
      color: INK,
      alignment,
    });

    const statsTable: Content = {
      table: {
        headerRows: 1,
        widths: ['*', 'auto', 'auto', 'auto', 'auto', 'auto', 'auto'],
        body: [
          [
            th('Field'),
            th('With value', 'right'),
            th('Distinct', 'right'),
            th('Min', 'right'),
            th('Max', 'right'),
            th('Mean', 'right'),
            th('Sum', 'right'),
          ],
          ...input.stats.map((s): TableCell[] => [
            s.name,
            { text: fmt(s.withValue), alignment: 'right' },
            { text: fmt(s.distinct), alignment: 'right' },
            {
              text: s.min === undefined ? '—' : fmt(s.min),
              alignment: 'right',
            },
            {
              text: s.max === undefined ? '—' : fmt(s.max),
              alignment: 'right',
            },
            {
              text: s.mean === undefined ? '—' : fmt(s.mean),
              alignment: 'right',
            },
            {
              text: s.sum === undefined ? '—' : fmt(s.sum),
              alignment: 'right',
            },
          ]),
        ],
      },
      layout: tableLayout(),
      fontSize: 8.5,
    };

    const featureTable: Content =
      input.rows.length === 0
        ? {
            text: 'No features match this report.',
            italics: true,
            color: MUTED,
          }
        : {
            table: {
              headerRows: 1,
              widths: input.fields.map(() => '*'),
              body: [
                input.fields.map((f) =>
                  th(f.name, f.kind === 'number' ? 'right' : 'left'),
                ),
                ...input.rows.map((row) =>
                  input.fields.map((f): TableCell => ({
                    text: cellText(row[f.name]),
                    alignment: f.kind === 'number' ? 'right' : 'left',
                  })),
                ),
              ],
            },
            layout: tableLayout(),
            fontSize: 7.5,
          };

    return {
      pageSize: 'A4',
      pageOrientation: wide ? 'landscape' : 'portrait',
      pageMargins: [36, 40, 36, 44],
      defaultStyle: { font: 'Helvetica', fontSize: 9, color: INK },
      info: { title: input.title, creator: 'Municipal GIS Platform' },
      footer: (currentPage, pageCount) => ({
        columns: [
          { text: input.municipality, color: MUTED },
          {
            text: `Page ${currentPage} of ${pageCount}`,
            alignment: 'right',
            color: MUTED,
          },
        ],
        margin: [36, 12, 36, 0],
        fontSize: 7.5,
      }),
      content: [
        { text: input.title, fontSize: 17, bold: true },
        {
          text: [
            input.municipality,
            ` · Generated ${generated}`,
            input.generatedBy ? ` by ${input.generatedBy}` : '',
          ].join(''),
          color: MUTED,
          margin: [0, 3, 0, 4],
        },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: wide ? 770 : 523,
              y2: 0,
              lineWidth: 1.5,
              lineColor: ACCENT,
            },
          ],
          margin: [0, 0, 0, 12],
        },
        {
          table: {
            widths: [110, '*'],
            body: input.details.map(([k, v]) => [
              { text: k, color: MUTED },
              { text: v, bold: k === 'Layer' },
            ]),
          },
          layout: 'noBorders',
          margin: [0, 0, 0, 14],
        },
        { text: 'Summary', fontSize: 12, bold: true, margin: [0, 0, 0, 6] },
        statsTable,
        {
          text: 'Features',
          fontSize: 12,
          bold: true,
          margin: [0, 16, 0, 6],
          pageBreak: input.rows.length > 25 ? 'before' : undefined,
        },
        featureTable,
      ],
    };
  }

  private render(doc: TDocumentDefinitions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const pdf = this.printer.createPdfKitDocument(doc);
      const chunks: Buffer[] = [];
      pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
      pdf.on('end', () => resolve(Buffer.concat(chunks)));
      pdf.on('error', reject);
      pdf.end();
    });
  }
}

/** Header rule, hairline row rules and zebra rows. */
function tableLayout() {
  return {
    hLineWidth: (i: number, node: { table: { headerRows?: number } }) =>
      i === (node.table.headerRows ?? 0) ? 1 : 0.5,
    vLineWidth: () => 0,
    hLineColor: () => RULE,
    fillColor: (row: number) => (row > 0 && row % 2 === 0 ? ZEBRA : null),
    paddingTop: () => 3,
    paddingBottom: () => 3,
    paddingLeft: () => 4,
    paddingRight: () => 4,
  };
}

function fmt(value: number): string {
  return value.toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return fmt(value);
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean' || typeof value === 'bigint') {
    return value.toString();
  }
  return JSON.stringify(value) ?? '—';
}
