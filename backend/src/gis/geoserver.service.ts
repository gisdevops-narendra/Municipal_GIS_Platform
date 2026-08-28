import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PostgisConnectionParams {
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  schema?: string;
}

export interface GeoServerHealth {
  reachable: boolean;
  version?: string;
  message?: string;
}

export interface EnsureFeatureTypeParams {
  /** Published layer name, e.g. "roads". */
  name: string;
  /** Underlying PostGIS table name, e.g. "gis_demo_roads". */
  nativeName: string;
  title: string;
  /** Native/declared CRS, e.g. "EPSG:32643". */
  srs: string;
  /** Restricts this feature type to one municipality's rows in a shared
   *  demo table, e.g. "gis_workspace_id = 'xyz'" — see docs/backend.md
   *  "GIS Layers" for why this is the real tenant-isolation boundary for
   *  OGC requests (not just our own API's filtering). Omit entirely for
   *  Task 7 uploaded layers: each has its own dedicated PostGIS table
   *  (never shared across municipalities), so no row-level filter is
   *  needed — the table itself is the isolation boundary. */
  cqlFilter?: string;
}

export interface LonLatBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Low-level, server-side-only client for the GeoServer REST Admin API.
 * Angular never talks to GeoServer directly — see docs/backend.md
 * "GeoServer". Every method here is a thin, idempotent-where-possible
 * wrapper around one REST call; orchestration (create-workspace-then-
 * datastore, retry policy) lives in GisWorkspaceService.
 */
@Injectable()
export class GeoServerService {
  private readonly logger = new Logger(GeoServerService.name);
  private readonly baseUrl: string;
  private readonly authHeader: string;

  constructor(private readonly config: ConfigService) {
    this.baseUrl = this.config
      .getOrThrow<string>('GEOSERVER_URL')
      .replace(/\/+$/, '');
    const user = this.config.getOrThrow<string>('GEOSERVER_ADMIN_USER');
    const password = this.config.getOrThrow<string>('GEOSERVER_ADMIN_PASSWORD');
    this.authHeader = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
  }

  /** Task 8: server-side WFS GetFeature (GeoJSON) for the export feature —
   *  fetched by the backend itself (not handed to the browser as a
   *  GeoServer URL) so EXPORT permission is actually enforced at the
   *  point of data access, not just at the point of handing out a link.
   *  Uses the same admin-authenticated request path as every other
   *  GeoServer call here; GeoServer's WFS also happens to be reachable
   *  anonymously, but there's no reason not to reuse the one client this
   *  service already has. */
  async getFeaturesAsGeoJson(
    workspace: string,
    layer: string,
    options: {
      maxFeatures?: number;
      timeoutMs?: number;
      srsName?: string;
    } = {},
  ): Promise<string> {
    const qualifiedLayer = `${workspace}:${layer}`;
    const params = new URLSearchParams({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: qualifiedLayer,
      outputFormat: 'application/json',
    });
    if (options.maxFeatures) {
      params.set('count', String(options.maxFeatures));
    }
    if (options.srsName) {
      // Task 9 search: features/bboxes must come back in EPSG:4326 to
      // match GISLayer.bbox's own convention, regardless of the
      // workspace's storage CRS (e.g. EPSG:32643) — never assumed by the
      // caller, always requested explicitly. Export (Task 8) leaves this
      // unset and gets GeoServer's native/default CRS, unchanged.
      params.set('srsName', options.srsName);
    }
    const response = await this.request(
      `/${encodeURIComponent(workspace)}/wfs?${params.toString()}`,
      { method: 'GET' },
      options.timeoutMs ?? 30000,
    );
    if (!response.ok) {
      throw await this.toError('exporting layer features', response);
    }
    return response.text();
  }

  async checkHealth(): Promise<GeoServerHealth> {
    try {
      const response = await this.request(
        '/rest/about/version.json',
        { method: 'GET' },
        5000,
      );
      if (!response.ok) {
        return {
          reachable: false,
          message: `GeoServer responded with HTTP ${response.status}`,
        };
      }
      const body = (await response.json()) as {
        about?: { resource?: { '@name': string; Version?: string }[] };
      };
      const version = body.about?.resource?.find(
        (r) => r['@name'] === 'GeoServer',
      )?.Version;
      return { reachable: true, version };
    } catch (error) {
      this.logger.warn(
        `GeoServer health check failed: ${(error as Error).message}`,
      );
      return { reachable: false, message: 'GeoServer is unreachable.' };
    }
  }

  async workspaceExists(workspace: string): Promise<boolean> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}.json`,
      { method: 'GET' },
    );
    if (response.status === 404) return false;
    if (!response.ok)
      throw await this.toError('checking workspace existence', response);
    return true;
  }

  /** Idempotent: if the workspace already exists, does nothing rather than
   *  erroring — safe to call repeatedly (retry-safe provisioning). */
  async ensureWorkspace(workspace: string): Promise<void> {
    if (await this.workspaceExists(workspace)) {
      return;
    }
    const response = await this.request('/rest/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: { name: workspace } }),
    });
    // 409 means another concurrent request created it first — fine, the
    // desired end state (workspace exists) is already true.
    if (!response.ok && response.status !== 409) {
      throw await this.toError('creating workspace', response);
    }
  }

  async datastoreExists(
    workspace: string,
    datastore: string,
  ): Promise<boolean> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}.json`,
      { method: 'GET' },
    );
    if (response.status === 404) return false;
    if (!response.ok)
      throw await this.toError('checking datastore existence', response);
    return true;
  }

  /** Idempotent: safe to call repeatedly, same as ensureWorkspace. */
  async ensurePostgisDatastore(
    workspace: string,
    datastore: string,
    connection: PostgisConnectionParams,
  ): Promise<void> {
    if (await this.datastoreExists(workspace, datastore)) {
      return;
    }

    const entry = (key: string, value: string) => ({ '@key': key, $: value });
    const body = {
      dataStore: {
        name: datastore,
        connectionParameters: {
          entry: [
            entry('dbtype', 'postgis'),
            entry('host', connection.host),
            entry('port', connection.port),
            entry('database', connection.database),
            entry('schema', connection.schema ?? 'public'),
            entry('user', connection.user),
            entry('passwd', connection.password),
            entry('Expose primary keys', 'true'),
            entry('validate connections', 'true'),
          ],
        },
      },
    };

    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok && response.status !== 409) {
      throw await this.toError('creating PostGIS datastore', response);
    }
  }

  /** Confirms GeoServer can actually reach PostGIS through this datastore
   *  (not just that the config was accepted) by asking it to list feature
   *  types — this call fails if the underlying DB connection is broken. */
  async checkDatastoreConnection(
    workspace: string,
    datastore: string,
  ): Promise<boolean> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}/featuretypes.json?list=all`,
      { method: 'GET' },
    );
    return response.ok;
  }

  async featureTypeExists(
    workspace: string,
    datastore: string,
    layer: string,
  ): Promise<boolean> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}/featuretypes/${encodeURIComponent(layer)}.json`,
      { method: 'GET' },
    );
    if (response.status === 404) return false;
    if (!response.ok)
      throw await this.toError('checking feature type existence', response);
    return true;
  }

  /**
   * Idempotent: publishes a PostGIS table as a GeoServer feature type
   * (WMS/WFS layer) if it doesn't already exist, restricted to one
   * municipality's rows via `cqlFilter`. Bounding boxes are requested via
   * `recalculate=nativebbox,latlonbbox` at creation time. Either way
   * (freshly created or already existing), fetches and returns the current
   * lon/lat bounding box so callers can persist it — this keeps it correct
   * even across retries against a layer that already existed.
   */
  async ensureFeatureType(
    workspace: string,
    datastore: string,
    params: EnsureFeatureTypeParams,
  ): Promise<LonLatBoundingBox | null> {
    const exists = await this.featureTypeExists(
      workspace,
      datastore,
      params.name,
    );
    if (!exists) {
      const response = await this.request(
        `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}/featuretypes?recalculate=nativebbox,latlonbbox`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            featureType: {
              name: params.name,
              nativeName: params.nativeName,
              title: params.title,
              srs: params.srs,
              nativeCRS: params.srs,
              ...(params.cqlFilter ? { cqlFilter: params.cqlFilter } : {}),
              enabled: true,
            },
          }),
        },
      );
      if (!response.ok && response.status !== 409) {
        throw await this.toError('publishing feature type', response);
      }
    }

    return this.getFeatureTypeBoundingBox(workspace, datastore, params.name);
  }

  /** Deletes a published feature type (`recurse=true` also removes the
   *  GeoServer layer entry itself, not just the feature type resource).
   *  Idempotent: a already-absent feature type is treated as success, not
   *  an error — safe to call on a retry. Used when a new layer version
   *  replaces an older one (see Task 7 §16/GisUploadsService.publish) —
   *  only ever called AFTER the new version's own feature type has been
   *  successfully created and verified, never before. */
  async deleteFeatureType(
    workspace: string,
    datastore: string,
    layer: string,
  ): Promise<void> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}/featuretypes/${encodeURIComponent(layer)}?recurse=true`,
      { method: 'DELETE' },
    );
    if (!response.ok && response.status !== 404) {
      throw await this.toError('deleting feature type', response);
    }
  }

  // ---------------------------------------------------------------------
  // Styling (GIS Layer Styling — YSLD). All styles are workspace-scoped so
  // they never collide across municipalities. One style per layer, named
  // `<geoserverLayer>_style`, set as the layer's default style.
  // ---------------------------------------------------------------------

  private readonly YSLD_CONTENT_TYPE = 'application/vnd.geoserver.ysld+yaml';

  async styleExists(workspace: string, name: string): Promise<boolean> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/styles/${encodeURIComponent(name)}.json`,
      { method: 'GET' },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw await this.toError('checking style existence', response);
    }
    return true;
  }

  /**
   * Creates or replaces a workspace style holding `ysld`. A syntactically
   * invalid YSLD comes back from GeoServer as HTTP 400 — surfaced as a
   * `BadRequestException` with the parser message so the editor can show
   * it, rather than a generic 503.
   */
  async putYsldStyle(
    workspace: string,
    name: string,
    ysld: string,
  ): Promise<void> {
    if (!(await this.styleExists(workspace, name))) {
      const created = await this.request(
        `/rest/workspaces/${encodeURIComponent(workspace)}/styles`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            style: { name, format: 'ysld', filename: `${name}.ysld` },
          }),
        },
      );
      if (!created.ok && created.status !== 409) {
        throw await this.toError('creating style', created);
      }
    }

    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/styles/${encodeURIComponent(name)}?raw=true`,
      {
        method: 'PUT',
        headers: { 'Content-Type': this.YSLD_CONTENT_TYPE },
        body: ysld,
      },
      30000,
    );
    if (response.status === 400) {
      const detail = await response.text().catch(() => '');
      throw new BadRequestException(
        `The style is not valid: ${this.firstLine(detail) || 'GeoServer rejected the YSLD.'}`,
      );
    }
    if (!response.ok) {
      throw await this.toError('saving style', response);
    }
  }

  async getStyleBody(workspace: string, name: string): Promise<string | null> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/styles/${encodeURIComponent(name)}.ysld`,
      { method: 'GET', headers: { Accept: this.YSLD_CONTENT_TYPE } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw await this.toError('reading style', response);
    }
    return response.text();
  }

  /** Idempotent — an already-absent style is success. */
  async deleteStyle(workspace: string, name: string): Promise<void> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/styles/${encodeURIComponent(name)}?recurse=true&purge=true`,
      { method: 'DELETE' },
    );
    if (!response.ok && response.status !== 404) {
      throw await this.toError('deleting style', response);
    }
  }

  // ---------------------------------------------------------------------
  // Style resources (ExternalGraphic icon files). GeoServer resolves a
  // relative `external:` url in a workspace YSLD against that workspace's
  // style resource directory: `workspaces/<ws>/styles/<file>`. We push
  // icon bytes there with the Resource REST API so the same style keeps
  // rendering after a save/reload with no external hosting.
  // ---------------------------------------------------------------------

  private styleResourcePath(workspace: string, filename: string): string {
    return `/rest/resource/workspaces/${encodeURIComponent(workspace)}/styles/${encodeURIComponent(filename)}`;
  }

  async styleResourceExists(
    workspace: string,
    filename: string,
  ): Promise<boolean> {
    const response = await this.request(
      this.styleResourcePath(workspace, filename),
      { method: 'HEAD' },
    );
    if (response.status === 404) return false;
    if (!response.ok) {
      throw await this.toError('checking style resource', response);
    }
    return true;
  }

  /** Creates or replaces an icon file in the workspace's style dir. */
  async putStyleResource(
    workspace: string,
    filename: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    const response = await this.request(
      this.styleResourcePath(workspace, filename),
      {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(body),
      },
      30000,
    );
    if (!response.ok) {
      throw await this.toError('uploading style resource', response);
    }
  }

  /** Raw bytes of an icon file, or null if absent. */
  async getStyleResource(
    workspace: string,
    filename: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const response = await this.request(
      this.styleResourcePath(workspace, filename),
      { method: 'GET' },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      throw await this.toError('reading style resource', response);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      body: buffer,
      contentType:
        response.headers.get('content-type') || 'application/octet-stream',
    };
  }

  /** Idempotent — an already-absent resource is success. */
  async deleteStyleResource(
    workspace: string,
    filename: string,
  ): Promise<void> {
    const response = await this.request(
      this.styleResourcePath(workspace, filename),
      { method: 'DELETE' },
    );
    if (!response.ok && response.status !== 404) {
      throw await this.toError('deleting style resource', response);
    }
  }

  /**
   * Points a published layer at its default style. `styleWorkspace`
   * omitted → a GeoServer built-in style (`point` / `line` / `polygon`),
   * used to revert a layer to the unstyled default.
   */
  async setLayerDefaultStyle(
    workspace: string,
    layer: string,
    styleName: string,
    styleWorkspace?: string,
  ): Promise<void> {
    const response = await this.request(
      `/rest/layers/${encodeURIComponent(`${workspace}:${layer}`)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layer: {
            defaultStyle: styleWorkspace
              ? { name: styleName, workspace: styleWorkspace }
              : { name: styleName },
          },
        }),
      },
    );
    if (!response.ok) {
      throw await this.toError('setting layer default style', response);
    }
  }

  private firstLine(text: string): string {
    return (
      text
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0)
        ?.slice(0, 300) ?? ''
    );
  }

  private async getFeatureTypeBoundingBox(
    workspace: string,
    datastore: string,
    layer: string,
  ): Promise<LonLatBoundingBox | null> {
    const response = await this.request(
      `/rest/workspaces/${encodeURIComponent(workspace)}/datastores/${encodeURIComponent(datastore)}/featuretypes/${encodeURIComponent(layer)}.json`,
      { method: 'GET' },
    );
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as {
      featureType?: {
        // GeoServer serializes these as JSON numbers for a normal bbox,
        // but as strings (observed: scientific notation like
        // "-9.02e-6") for a degenerate/empty one — e.g. a freshly
        // published layer over a table with no rows yet for this
        // municipality. Coerce explicitly rather than trusting the type.
        latLonBoundingBox?: {
          minx: number | string;
          miny: number | string;
          maxx: number | string;
          maxy: number | string;
        };
      };
    };
    const bbox = body.featureType?.latLonBoundingBox;
    if (!bbox) {
      return null;
    }
    const minX = Number(bbox.minx);
    const minY = Number(bbox.miny);
    const maxX = Number(bbox.maxx);
    const maxY = Number(bbox.maxy);
    if (![minX, minY, maxX, maxY].every(Number.isFinite)) {
      return null;
    }
    return { minX, minY, maxX, maxY };
  }

  private async request(
    path: string,
    init: RequestInit,
    timeoutMs = 15000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { ...init.headers, Authorization: this.authHeader },
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `GeoServer is unavailable: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async toError(action: string, response: Response): Promise<Error> {
    const body = await response.text().catch(() => '');
    this.logger.error(
      `GeoServer error while ${action} (HTTP ${response.status}): ${body}`,
    );
    return new ServiceUnavailableException(
      `GeoServer request failed while ${action}.`,
    );
  }
}
