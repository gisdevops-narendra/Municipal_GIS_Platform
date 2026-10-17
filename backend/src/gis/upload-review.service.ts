import { Injectable } from '@nestjs/common';
import type { GISLayerUpload } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { isSafeGeneratedTableName } from './layer-naming.util';

export type ReviewSeverity = 'high' | 'medium' | 'low' | 'info';

export interface ReviewFinding {
  /** Stable id, e.g. "location.outside", for the UI / tests. */
  check: string;
  severity: ReviewSeverity;
  title: string;
  detail: string;
}

export interface UploadReviewReport {
  /** 0 (nothing found) … 100. */
  riskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
  /** One or two sentences a reviewer can act on. */
  summary: string;
  findings: ReviewFinding[];
  /** The published layer this upload would replace, if any. */
  replaces: { id: string; name: string; version: number } | null;
  checkedAt: string;
}

const WEIGHT: Record<ReviewSeverity, number> = { high: 40, medium: 15, low: 5, info: 0 };
/** Columns GDAL / the platform add — not part of the user's schema. */
const SYSTEM_COLUMNS = new Set(['ogc_fid', 'geom', 'gis_workspace_id', 'fid', 'id']);

type Bbox = [number, number, number, number];
type Column = { name: string; type: string };

/**
 * Automated pre-review of an upload (AI-assisted review, Phase 2): the
 * checks a careful reviewer would run by hand before approving, on the
 * already-imported staging table — nothing is changed.
 *
 *   geometry   invalid / empty / exact duplicates / slivers
 *   location   outside the municipality's existing data (wrong CRS?),
 *              x/y swapped
 *   schema     fields dropped / added / retyped vs. the layer it replaces;
 *              geometry type change; big feature-count change
 *   duplicate  looks like a re-upload of another published layer
 *   attributes columns that are entirely or mostly empty
 *
 * Every finding is rule-based and explains itself; the weighted findings
 * give the risk score (high 40, medium 15, low 5; capped at 100).
 */
@Injectable()
export class UploadReviewService {
  constructor(private readonly prisma: PrismaService) {}

  async review(upload: GISLayerUpload): Promise<UploadReviewReport> {
    const table = upload.postgisTable;
    if (!table || !isSafeGeneratedTableName(table)) {
      return this.report([
        {
          check: 'staging.missing',
          severity: 'info',
          title: 'Not imported yet',
          detail: 'The file has not been validated and imported, so there is nothing to check yet.',
        },
      ], null);
    }

    const findings: ReviewFinding[] = [];
    const replaces = await this.prisma.gISLayer.findFirst({
      where: {
        gisWorkspaceId: upload.gisWorkspaceId,
        code: upload.layerCode,
        status: 'ACTIVE',
      },
      select: {
        id: true, name: true, version: true, postgisTable: true, geometryType: true,
        bboxMinX: true, bboxMinY: true, bboxMaxX: true, bboxMaxY: true,
      },
    });

    const stats = await this.geometryStats(table, upload.geometryType);
    findings.push(...this.geometryFindings(stats));

    const bbox = await this.bbox4326(table);
    if (bbox) findings.push(...(await this.locationFindings(upload, bbox, replaces?.id ?? null)));

    const columns = await this.columns(table);
    if (replaces?.postgisTable && isSafeGeneratedTableName(replaces.postgisTable)) {
      findings.push(
        ...this.schemaFindings(columns, await this.columns(replaces.postgisTable)),
        ...(await this.versionFindings(upload, stats.total, replaces)),
      );
    }
    findings.push(...(await this.duplicateFindings(upload, bbox, columns, stats.total, replaces?.id ?? null)));
    findings.push(...(await this.attributeFindings(table, columns, stats.total)));

    return this.report(
      findings,
      replaces ? { id: replaces.id, name: replaces.name, version: replaces.version } : null,
    );
  }

  // ----- geometry -----

  private async geometryStats(table: string, geometryType: string | null) {
    const measure =
      geometryType === 'POLYGON'
        ? 'ST_Area(ST_Transform(geom, 4326)::geography)'
        : geometryType === 'LINE'
          ? 'ST_Length(ST_Transform(geom, 4326)::geography)'
          : null;
    const [row] = await this.prisma.$queryRawUnsafe<
      { total: number; invalid: number; empty: number; tiny: number }[]
    >(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND NOT ST_IsValid(geom))::int AS invalid,
              count(*) FILTER (WHERE geom IS NULL OR ST_IsEmpty(geom))::int AS empty,
              ${measure
                ? `count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND ${measure} < ${geometryType === 'POLYGON' ? 1 : 0.5})::int`
                : '0'} AS tiny
         FROM "${table}"`,
    );
    const [dup] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM (
         SELECT 1 FROM "${table}" a JOIN "${table}" b
           ON a.ogc_fid < b.ogc_fid AND a.geom && b.geom AND a.geom = b.geom
         LIMIT 10000) d`,
    );
    return {
      total: Number(row?.total ?? 0),
      invalid: Number(row?.invalid ?? 0),
      empty: Number(row?.empty ?? 0),
      tiny: Number(row?.tiny ?? 0),
      duplicates: Number(dup?.n ?? 0),
      geometryType,
    };
  }

  private geometryFindings(s: Awaited<ReturnType<UploadReviewService['geometryStats']>>): ReviewFinding[] {
    const out: ReviewFinding[] = [];
    const pct = (n: number) => (s.total ? `${((100 * n) / s.total).toFixed(1)} %` : '0 %');
    if (s.total === 0) {
      out.push({ check: 'geometry.none', severity: 'high', title: 'No features', detail: 'The upload contains no features.' });
      return out;
    }
    if (s.invalid) {
      out.push({
        check: 'geometry.invalid',
        severity: s.invalid / s.total > 0.05 ? 'high' : 'medium',
        title: 'Invalid geometries',
        detail: `${s.invalid} of ${s.total} features (${pct(s.invalid)}) have invalid geometry (self-intersections, bad rings). They may render or measure wrongly; Data Tools → Validate can repair them after publishing.`,
      });
    }
    if (s.empty) {
      out.push({
        check: 'geometry.empty',
        severity: s.empty / s.total > 0.05 ? 'high' : 'medium',
        title: 'Features without a location',
        detail: `${s.empty} features (${pct(s.empty)}) have no geometry and will not appear on the map.`,
      });
    }
    if (s.duplicates) {
      out.push({
        check: 'geometry.duplicates',
        severity: s.duplicates / s.total > 0.05 ? 'medium' : 'low',
        title: 'Duplicate features',
        detail: `${s.duplicates} pair(s) of features have exactly the same geometry — often the same record entered twice.`,
      });
    }
    if (s.tiny) {
      out.push({
        check: 'geometry.slivers',
        severity: s.tiny / s.total > 0.05 ? 'medium' : 'low',
        title: s.geometryType === 'POLYGON' ? 'Sliver polygons' : 'Very short lines',
        detail: `${s.tiny} features (${pct(s.tiny)}) are smaller than ${s.geometryType === 'POLYGON' ? '1 m²' : '0.5 m'} — usually digitising leftovers.`,
      });
    }
    return out;
  }

  // ----- location -----

  private async bbox4326(table: string): Promise<Bbox | null> {
    const [row] = await this.prisma.$queryRawUnsafe<{ x1: number | null; y1: number; x2: number; y2: number }[]>(
      `SELECT ST_XMin(e) AS x1, ST_YMin(e) AS y1, ST_XMax(e) AS x2, ST_YMax(e) AS y2
         FROM (SELECT ST_Transform(ST_SetSRID(ST_Extent(geom)::geometry, max(ST_SRID(geom))), 4326) AS e
                 FROM "${table}" WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)) s`,
    );
    if (!row || row.x1 == null) return null;
    return [Number(row.x1), Number(row.y1), Number(row.x2), Number(row.y2)];
  }

  /** The municipality's own extent: the union of its published layers. */
  private async municipalityExtent(workspaceId: string, excludeLayerId: string | null): Promise<Bbox | null> {
    const layers = await this.prisma.gISLayer.findMany({
      where: {
        gisWorkspaceId: workspaceId,
        status: 'ACTIVE',
        bboxMinX: { not: null },
        ...(excludeLayerId ? { id: { not: excludeLayerId } } : {}),
      },
      select: { bboxMinX: true, bboxMinY: true, bboxMaxX: true, bboxMaxY: true },
    });
    const valid = layers.filter(
      (l) => Math.abs(l.bboxMinX!) <= 180 && Math.abs(l.bboxMaxY!) <= 90,
    );
    if (!valid.length) return null;
    return [
      Math.min(...valid.map((l) => l.bboxMinX!)),
      Math.min(...valid.map((l) => l.bboxMinY!)),
      Math.max(...valid.map((l) => l.bboxMaxX!)),
      Math.max(...valid.map((l) => l.bboxMaxY!)),
    ];
  }

  private async locationFindings(upload: GISLayerUpload, bbox: Bbox, replacesId: string | null): Promise<ReviewFinding[]> {
    const [x1, y1, x2, y2] = bbox;
    if (![x1, y1, x2, y2].every(Number.isFinite) || Math.abs(x1) > 180 || Math.abs(y2) > 90) {
      return [{
        check: 'location.invalid',
        severity: 'high',
        title: 'Coordinates are not on Earth',
        detail: `The data's extent (${bbox.map((v) => v.toFixed(2)).join(', ')}) is not a valid longitude/latitude — the coordinate system (${upload.sourceCrs ?? 'unknown'}) is almost certainly wrong.`,
      }];
    }
    const home = await this.municipalityExtent(upload.gisWorkspaceId, replacesId);
    if (!home) return [];
    // Grow the municipality extent by 20 % (min ~2 km) — new data at the
    // edge of town is normal; data in another city is not.
    const padX = Math.max((home[2] - home[0]) * 0.2, 0.02);
    const padY = Math.max((home[3] - home[1]) * 0.2, 0.02);
    const area: Bbox = [home[0] - padX, home[1] - padY, home[2] + padX, home[3] + padY];
    const overlap = this.overlapFraction(bbox, area);
    if (overlap >= 0.5) return [];

    const swapped: Bbox = [y1, x1, y2, x2];
    if (this.overlapFraction(swapped, area) >= 0.5) {
      return [{
        check: 'location.swapped',
        severity: 'high',
        title: 'Longitude and latitude look swapped',
        detail: 'The data lands far from the municipality, but would fall inside it with X and Y exchanged — the X/Y (or lat/long) columns were probably mapped the wrong way round.',
      }];
    }
    const km = this.distanceKm(
      [(x1 + x2) / 2, (y1 + y2) / 2],
      [(home[0] + home[2]) / 2, (home[1] + home[3]) / 2],
    );
    return [{
      check: overlap > 0 ? 'location.partly_outside' : 'location.outside',
      severity: overlap > 0 ? 'medium' : 'high',
      title: overlap > 0 ? 'Partly outside the municipality' : 'Outside the municipality',
      detail: overlap > 0
        ? `Only ${(overlap * 100).toFixed(0)} % of the data's extent overlaps the area covered by the municipality's other layers.`
        : `The data is about ${km.toFixed(0)} km from the municipality's other layers. Check the coordinate system (detected: ${upload.sourceCrs ?? 'unknown'}).`,
    }];
  }

  // ----- schema / version -----

  private async columns(table: string): Promise<Column[]> {
    const rows = await this.prisma.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
      table,
    );
    return rows
      .filter((r) => !SYSTEM_COLUMNS.has(r.column_name) && r.data_type !== 'USER-DEFINED')
      .map((r) => ({ name: r.column_name, type: r.data_type }));
  }

  private schemaFindings(next: Column[], current: Column[]): ReviewFinding[] {
    const out: ReviewFinding[] = [];
    const nextBy = new Map(next.map((c) => [c.name, c]));
    const curBy = new Map(current.map((c) => [c.name, c]));
    const dropped = current.filter((c) => !nextBy.has(c.name)).map((c) => c.name);
    const added = next.filter((c) => !curBy.has(c.name)).map((c) => c.name);
    const retyped = next
      .filter((c) => curBy.has(c.name) && this.typeFamily(curBy.get(c.name)!.type) !== this.typeFamily(c.type))
      .map((c) => `${c.name} (${curBy.get(c.name)!.type} → ${c.type})`);
    const list = (names: string[]) => names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '');
    if (dropped.length) {
      out.push({
        check: 'schema.dropped',
        severity: dropped.length / Math.max(current.length, 1) > 0.25 ? 'high' : 'medium',
        title: 'Fields would be removed',
        detail: `${dropped.length} field(s) of the current layer are missing from this upload: ${list(dropped)}. Their values, styles and queries that use them would be lost.`,
      });
    }
    if (retyped.length) {
      out.push({
        check: 'schema.retyped',
        severity: 'medium',
        title: 'Field types change',
        detail: `${list(retyped)}. Numeric filters, styles or calculations on these fields may stop working.`,
      });
    }
    if (added.length) {
      out.push({
        check: 'schema.added',
        severity: 'info',
        title: 'New fields',
        detail: `This version adds: ${list(added)}.`,
      });
    }
    return out;
  }

  private async versionFindings(
    upload: GISLayerUpload,
    total: number,
    replaces: { id: string; name: string; postgisTable: string | null; geometryType: string | null },
  ): Promise<ReviewFinding[]> {
    const out: ReviewFinding[] = [];
    if (replaces.geometryType && upload.geometryType && replaces.geometryType !== upload.geometryType) {
      out.push({
        check: 'version.geometry_type',
        severity: 'high',
        title: 'Geometry type changes',
        detail: `"${replaces.name}" holds ${replaces.geometryType.toLowerCase()}s; this upload has ${upload.geometryType.toLowerCase()}s.`,
      });
    }
    const [row] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${replaces.postgisTable}"`,
    );
    const before = Number(row?.n ?? 0);
    if (before > 0) {
      const change = (total - before) / before;
      if (change <= -0.3 || change >= 1) {
        out.push({
          check: 'version.count_change',
          severity: change <= -0.5 ? 'high' : 'medium',
          title: change < 0 ? 'Many features would disappear' : 'Feature count jumps',
          detail: `The current "${replaces.name}" has ${before} features; this upload has ${total} (${change > 0 ? '+' : ''}${(change * 100).toFixed(0)} %).${change < 0 ? ' Is this a partial extract rather than the full layer?' : ''}`,
        });
      } else {
        out.push({
          check: 'version.count_change',
          severity: 'info',
          title: 'New version',
          detail: `Replaces "${replaces.name}" (${before} → ${total} features).`,
        });
      }
    }
    return out;
  }

  // ----- duplicates of other published layers -----

  private async duplicateFindings(
    upload: GISLayerUpload,
    bbox: Bbox | null,
    columns: Column[],
    total: number,
    replacesId: string | null,
  ): Promise<ReviewFinding[]> {
    if (!bbox || !upload.geometryType) return [];
    const candidates = await this.prisma.gISLayer.findMany({
      where: {
        gisWorkspaceId: upload.gisWorkspaceId,
        status: 'ACTIVE',
        layerType: 'VECTOR',
        geometryType: upload.geometryType,
        postgisTable: { not: null },
        bboxMinX: { not: null },
        ...(replacesId ? { id: { not: replacesId } } : {}),
      },
      select: {
        id: true, name: true, postgisTable: true,
        bboxMinX: true, bboxMinY: true, bboxMaxX: true, bboxMaxY: true,
      },
      take: 200,
    });
    const names = new Set(columns.map((c) => c.name));
    const out: ReviewFinding[] = [];
    for (const layer of candidates) {
      if (!isSafeGeneratedTableName(layer.postgisTable!)) continue;
      const other: Bbox = [layer.bboxMinX!, layer.bboxMinY!, layer.bboxMaxX!, layer.bboxMaxY!];
      const iou = this.iou(bbox, other);
      if (iou < 0.8) continue;
      const otherCols = await this.columns(layer.postgisTable!);
      const shared = otherCols.filter((c) => names.has(c.name)).length;
      const jaccard = shared / Math.max(1, new Set([...names, ...otherCols.map((c) => c.name)]).size);
      if (jaccard < 0.7) continue;
      const [row] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM "${layer.postgisTable}"`,
      );
      const n = Number(row?.n ?? 0);
      if (!n || Math.abs(total - n) / n > 0.1) continue;
      out.push({
        check: 'duplicate.layer',
        severity: 'medium',
        title: 'Looks like an existing layer',
        detail: `This upload closely matches the published layer "${layer.name}" (same area, ${Math.round(jaccard * 100)} % of fields in common, ${n} vs ${total} features). If it is an update, upload it under the same layer name to create a new version instead of a duplicate.`,
      });
    }
    return out.slice(0, 3);
  }

  // ----- attributes -----

  private async attributeFindings(table: string, columns: Column[], total: number): Promise<ReviewFinding[]> {
    if (!columns.length || total === 0) return [];
    const exprs = columns
      .slice(0, 150)
      .map((c, i) => `count(*) FILTER (WHERE "${c.name.replace(/"/g, '""')}" IS NULL OR trim("${c.name.replace(/"/g, '""')}"::text) = '')::int AS c${i}`);
    const [row] = await this.prisma.$queryRawUnsafe<Record<string, number>[]>(
      `SELECT ${exprs.join(', ')} FROM "${table}"`,
    );
    const empty: string[] = [];
    const sparse: string[] = [];
    columns.slice(0, 150).forEach((c, i) => {
      const blanks = Number(row?.[`c${i}`] ?? 0);
      if (blanks === total) empty.push(c.name);
      else if (blanks / total >= 0.8) sparse.push(c.name);
    });
    const out: ReviewFinding[] = [];
    const list = (names: string[]) => names.slice(0, 10).join(', ') + (names.length > 10 ? ` and ${names.length - 10} more` : '');
    if (empty.length) {
      out.push({
        check: 'attributes.empty',
        severity: empty.length / columns.length > 0.5 ? 'medium' : 'low',
        title: 'Empty fields',
        detail: `${empty.length} of ${columns.length} fields have no values at all: ${list(empty)}.`,
      });
    }
    if (sparse.length) {
      out.push({
        check: 'attributes.sparse',
        severity: 'info',
        title: 'Mostly empty fields',
        detail: `Filled for fewer than 20 % of features: ${list(sparse)}.`,
      });
    }
    return out;
  }

  // ----- scoring / helpers -----

  private report(
    findings: ReviewFinding[],
    replaces: UploadReviewReport['replaces'],
  ): UploadReviewReport {
    const order: ReviewSeverity[] = ['high', 'medium', 'low', 'info'];
    findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
    const riskScore = Math.min(100, findings.reduce((s, f) => s + WEIGHT[f.severity], 0));
    const riskLevel = riskScore >= 40 ? 'high' : riskScore >= 15 ? 'medium' : 'low';
    const serious = findings.filter((f) => f.severity === 'high' || f.severity === 'medium');
    const summary = serious.length
      ? `${riskLevel === 'high' ? 'Check before approving' : 'Worth a look'}: ${serious
          .slice(0, 3)
          .map((f) => f.title.toLowerCase())
          .join('; ')}${serious.length > 3 ? ` and ${serious.length - 3} more` : ''}.`
      : findings.some((f) => f.severity === 'low')
        ? 'No serious problems found — only minor notes below.'
        : 'No problems found by the automated checks.';
    return {
      riskScore,
      riskLevel,
      summary,
      findings,
      replaces,
      checkedAt: new Date().toISOString(),
    };
  }

  private typeFamily(type: string): string {
    const t = type.toLowerCase();
    if (/int|numeric|decimal|real|double|float/.test(t)) return 'number';
    if (/date|time/.test(t)) return 'date';
    if (/bool/.test(t)) return 'boolean';
    return 'text';
  }

  private area(b: Bbox): number {
    return Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  }

  private intersection(a: Bbox, b: Bbox): number {
    return this.area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
  }

  /** Share of `a` inside `b`; a point-like `a` counts as 1 when inside. */
  private overlapFraction(a: Bbox, b: Bbox): number {
    const area = this.area(a);
    if (area === 0) {
      const inside = a[0] >= b[0] && a[2] <= b[2] && a[1] >= b[1] && a[3] <= b[3];
      return inside ? 1 : 0;
    }
    return this.intersection(a, b) / area;
  }

  private iou(a: Bbox, b: Bbox): number {
    const inter = this.intersection(a, b);
    const union = this.area(a) + this.area(b) - inter;
    return union > 0 ? inter / union : 0;
  }

  private distanceKm(a: [number, number], b: [number, number]): number {
    const rad = Math.PI / 180;
    const dLat = (b[1] - a[1]) * rad;
    const dLon = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
}
