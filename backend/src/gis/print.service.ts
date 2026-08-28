import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GisLayersService } from './gis-layers.service';
import type { AppUser } from '../auth/types/app-user.type';
import type { PrintReportDto } from './dto/print-report.dto';

/** A resolved, authorised layer ready to go into the MapFish spec. */
interface ResolvedPrintLayer {
  name: string;
  geoserverWorkspace: string;
  geoserverLayer: string;
  opacity: number;
  cqlFilter?: string;
}

interface BasemapDefinition {
  baseURL: string;
  attribution: string;
}

/** The subset of the MapFish v3 request spec this service produces. */
export interface MapFishMapLayer {
  type: 'wms' | 'osm';
  baseURL: string;
  layers?: string[];
  imageFormat?: string;
  imageExtension?: string;
  opacity?: number;
  customParams?: Record<string, string>;
}

export interface MapFishPrintSpec {
  layout: string;
  outputFormat: 'pdf' | 'png';
  attributes: {
    title: string;
    metadata: string;
    printDate: string;
    attribution: string;
    showLegend: boolean;
    showScalebar: boolean;
    showNorthArrow: boolean;
    legend: { name: string; classes: { name: string; icons: string[] }[] };
    scalebar: Record<string, never>;
    northArrow: Record<string, never>;
    map: {
      projection: string;
      dpi: number;
      rotation: number;
      center: [number, number];
      scale: number;
      layers: MapFishMapLayer[];
    };
  };
}

/** Server-side allowlist — mirrors the front-end map.service.ts BASEMAPS.
 *  The client only ever sends an id, never a URL, so the print engine can
 *  only ever be pointed at one of these hosts. All use MapFish's `osm`
 *  layer type ({z}/{x}/{y}.png under baseURL). */
const BASEMAPS: Record<string, BasemapDefinition> = {
  osm: {
    baseURL: 'https://tile.openstreetmap.org',
    attribution: '© OpenStreetMap contributors',
  },
  'carto-light': {
    baseURL: 'https://basemaps.cartocdn.com/light_all',
    attribution: '© OpenStreetMap contributors © CARTO',
  },
  topo: {
    baseURL: 'https://tile.opentopomap.org',
    attribution:
      '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
  },
};

/**
 * Print Layout backend — the only thing that talks to MapFish Print.
 *
 * The Angular panel sends the live OpenLayers view (center/scale/rotation)
 * plus a list of GISLayer ids. This service:
 *   1. resolves those ids against the caller's own tenant-scoped,
 *      permission-filtered layer list (GisLayersService.listForMunicipality)
 *      — a layer the caller cannot VIEW can never be printed;
 *   2. builds the MapFish v3 request spec, with every GeoServer URL set to
 *      the compose-internal address (MAPFISH_GEOSERVER_URL) so the print
 *      container — not the browser — fetches the WMS imagery;
 *   3. POSTs to MapFish's synchronous buildreport endpoint and streams the
 *      PDF/PNG back.
 *
 * See docs/backend.md "Print Layout (MapFish Print)".
 */
@Injectable()
export class PrintService {
  private readonly logger = new Logger(PrintService.name);
  private readonly printBaseUrl: string;
  private readonly printApp: string;
  private readonly geoserverUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly gisLayers: GisLayersService,
    private readonly prisma: PrismaService,
  ) {
    this.printBaseUrl = this.config
      .getOrThrow<string>('MAPFISH_PRINT_URL')
      .replace(/\/+$/, '');
    this.printApp = this.config.get<string>(
      'MAPFISH_PRINT_APP',
      'municipal-gis',
    );
    this.geoserverUrl = this.config
      .getOrThrow<string>('MAPFISH_GEOSERVER_URL')
      .replace(/\/+$/, '');
  }

  /** Proxies MapFish's own capabilities.json — the panel uses it to
   *  populate the DPI list and confirm the layouts/formats exist. */
  async getCapabilities(): Promise<unknown> {
    const response = await this.request(
      `/${this.printApp}/capabilities.json`,
      { method: 'GET' },
      15000,
    );
    if (!response.ok) {
      throw new ServiceUnavailableException(
        'The print service is unavailable.',
      );
    }
    return response.json();
  }

  /**
   * Builds and runs one print job. Returns the finished document as a
   * Buffer plus the response metadata the controller needs to stream it.
   */
  async buildReport(
    appUser: AppUser,
    dto: PrintReportDto,
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const resolved = await this.resolveLayers(appUser, dto);
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { name: true },
    });

    const spec = this.buildSpec(dto, resolved, municipality?.name ?? '');

    const response = await this.request(
      `/${this.printApp}/buildreport.${dto.format}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      },
      120000,
    );

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      this.logger.error(
        `MapFish buildreport failed (HTTP ${response.status}): ${detail.slice(0, 2000)}`,
      );
      throw new ServiceUnavailableException(
        'The print service could not generate the map. Please try again.',
      );
    }

    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      contentType: dto.format === 'pdf' ? 'application/pdf' : 'image/png',
      filename: this.filenameFor(
        municipality?.name ?? 'municipal-gis',
        dto.format,
      ),
    };
  }

  // ------------------------------------------------------------------

  /** Maps each requested layerId to the caller's authoritative GISLayer
   *  record. A layerId the caller has no VIEW permission for (or that
   *  belongs to another municipality) is not in the list → 403. */
  private async resolveLayers(
    appUser: AppUser,
    dto: PrintReportDto,
  ): Promise<ResolvedPrintLayer[]> {
    const viewable = await this.gisLayers.listForMunicipality(appUser);
    const byId = new Map(viewable.map((layer) => [layer.id, layer]));

    return dto.layers.map((requested) => {
      const layer = byId.get(requested.layerId);
      if (!layer) {
        throw new ForbiddenException(
          'One or more of the selected layers is not available to print.',
        );
      }
      return {
        name: layer.name,
        geoserverWorkspace: layer.geoserverWorkspace,
        geoserverLayer: layer.geoserverLayer,
        opacity: requested.opacity ?? 1,
        cqlFilter: requested.cqlFilter?.trim() || undefined,
      };
    });
  }

  /**
   * Pure: DTO + resolved layers → MapFish v3 request spec. No I/O, so it
   * is fully unit-testable. Exposed for the spec test.
   */
  buildSpec(
    dto: PrintReportDto,
    layers: ResolvedPrintLayer[],
    municipalityName: string,
  ): MapFishPrintSpec {
    const basemapId = dto.basemapId ?? 'osm';
    const basemap = basemapId === 'none' ? null : (BASEMAPS[basemapId] ?? null);

    // MapFish renders map.layers top-first. The client already sends its
    // layers top-first; the basemap always goes last (bottom).
    const mapLayers: MapFishMapLayer[] = layers.map((layer) => ({
      type: 'wms',
      baseURL: `${this.geoserverUrl}/${layer.geoserverWorkspace}/wms`,
      layers: [`${layer.geoserverWorkspace}:${layer.geoserverLayer}`],
      imageFormat: 'image/png',
      opacity: layer.opacity,
      customParams: {
        TRANSPARENT: 'true',
        ...(layer.cqlFilter ? { CQL_FILTER: layer.cqlFilter } : {}),
      },
    }));

    if (basemap) {
      mapLayers.push({
        type: 'osm',
        baseURL: basemap.baseURL,
        imageExtension: 'png',
      });
    }

    const attribution = [municipalityName, basemap?.attribution]
      .filter(Boolean)
      .join('  ·  ');

    const legendClasses = dto.includeLegend
      ? layers.map((layer) => ({
          name: layer.name,
          icons: [this.legendGraphicUrl(layer)],
        }))
      : [];

    return {
      layout: `${dto.pageSize} ${dto.orientation}`,
      outputFormat: dto.format,
      attributes: {
        title: dto.title ?? '',
        metadata: dto.metadata ?? '',
        printDate: dto.includeDate ? new Date().toISOString().slice(0, 10) : '',
        attribution,
        showLegend: dto.includeLegend,
        showScalebar: dto.includeScalebar,
        showNorthArrow: dto.includeNorthArrow,
        // name '' — the Jasper template draws its own "Legend" heading, so
        // an extra group-name row from MapFish would just duplicate it.
        legend: { name: '', classes: legendClasses },
        scalebar: {},
        northArrow: {},
        map: {
          projection: dto.map.projection,
          dpi: dto.dpi,
          rotation: dto.map.rotation,
          center: dto.map.center,
          scale: dto.map.scale,
          layers: mapLayers,
        },
      },
    };
  }

  private legendGraphicUrl(layer: ResolvedPrintLayer): string {
    const params = new URLSearchParams({
      SERVICE: 'WMS',
      VERSION: '1.1.0',
      REQUEST: 'GetLegendGraphic',
      FORMAT: 'image/png',
      LAYER: `${layer.geoserverWorkspace}:${layer.geoserverLayer}`,
      LEGEND_OPTIONS: 'fontAntiAliasing:true;fontSize:11;dpi:96',
    });
    return `${this.geoserverUrl}/${layer.geoserverWorkspace}/wms?${params.toString()}`;
  }

  private filenameFor(municipalityName: string, format: string): string {
    const slug =
      municipalityName
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'municipal-gis';
    const date = new Date().toISOString().slice(0, 10);
    return `${slug}-map-${date}.${format}`;
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.printBaseUrl}${path}`, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `The print service is unreachable: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
