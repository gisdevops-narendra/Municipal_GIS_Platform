import {
  BadRequestException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { GeoServerService } from './geoserver.service';
import { YsldGenerator } from './ysld-generator';
import type {
  IconRefDto,
  LayerStyleSpecDto,
  SymbolSpecDto,
} from './dto/layer-style.dto';
import {
  isBuiltinIcon,
  markerIcon,
  MARKER_ICONS,
  readMarkerIcon,
  type MarkerIcon,
} from './marker-icons';

/** Uploaded icon files must stay small — they are inlined into the map
 *  render for every feature. 512 KB is generous for an SVG/PNG marker. */
const MAX_ICON_BYTES = 512 * 1024;

/** All style-resource icon files we manage share this prefix so they are
 *  easy to spot in the workspace style dir and never collide with a
 *  hand-uploaded GeoServer resource. */
const ICON_PREFIX = 'mgp_icon_';

export interface UploadedIcon {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

export interface StyleTarget {
  /** GeoServer workspace the layer + style live in. */
  workspace: string;
  /** Published GeoServer layer name (feature type). */
  geoserverLayer: string;
  /** Workspace-scoped style name. Defaults to `<geoserverLayer>_style`. */
  styleName?: string;
}

/**
 * Style primitives — no tenant/permission logic (the callers,
 * `GisLayersService` / `GisUploadsService`, resolve and authorise the
 * layer first). Turns a `LayerStyleSpec` into YSLD, stores it in GeoServer
 * as a workspace style, and points the layer's default style at it. See
 * docs/backend.md "GIS Layer Styling".
 */
@Injectable()
export class StyleService {
  private readonly logger = new Logger(StyleService.name);

  constructor(
    private readonly geoServer: GeoServerService,
    private readonly ysld: YsldGenerator,
  ) {}

  styleNameFor(geoserverLayer: string): string {
    return `${geoserverLayer}_style`;
  }

  /** The bundled marker-icon catalogue, for the picker gallery. */
  builtinIcons(): MarkerIcon[] {
    return MARKER_ICONS;
  }

  /** Raw SVG bytes of a bundled marker icon (or null for an unknown id). */
  builtinIconBytes(id: string): Buffer | null {
    return readMarkerIcon(id);
  }

  /**
   * Generates YSLD from `spec`, saves it as `<target>` workspace style,
   * and sets it as the layer's default style. Any point icon referenced
   * by the spec is first materialised into the workspace's style resource
   * dir so the ExternalGraphic URL keeps resolving after a reload.
   * Throws `BadRequestException` on invalid YSLD (GeoServer 400),
   * `ServiceUnavailableException` if GeoServer is unreachable.
   */
  async applyStyle(
    target: StyleTarget,
    spec: LayerStyleSpecDto,
  ): Promise<{ styleName: string; ysld: string }> {
    const styleName =
      target.styleName ?? this.styleNameFor(target.geoserverLayer);
    const resolved = await this.resolveSpecIcons(target.workspace, spec);
    const ysld = this.ysld.generate(resolved, styleName);
    await this.geoServer.putYsldStyle(target.workspace, styleName, ysld);
    await this.geoServer.setLayerDefaultStyle(
      target.workspace,
      target.geoserverLayer,
      styleName,
      target.workspace,
    );
    return { styleName, ysld };
  }

  /**
   * Validates and stores a user-supplied icon (SVG or PNG) in the
   * workspace's style resource directory under a content-hashed name, so
   * repeated uploads of the same file are de-duplicated. Returns the
   * `IconRef` the frontend should persist in the style spec.
   */
  async uploadIcon(
    workspace: string,
    file: UploadedIcon,
  ): Promise<IconRefDto & { source: 'custom' }> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('The icon file is empty.');
    }
    if (file.buffer.length > MAX_ICON_BYTES) {
      throw new PayloadTooLargeException(
        `Icon must be ${Math.round(MAX_ICON_BYTES / 1024)} KB or smaller.`,
      );
    }

    const isPng =
      file.mimetype === 'image/png' || this.looksLikePng(file.buffer);
    const isSvg =
      file.mimetype === 'image/svg+xml' ||
      /\.svg$/i.test(file.originalname ?? '') ||
      this.looksLikeSvg(file.buffer);

    let body: Buffer;
    let mime: IconRefDto['mime'];
    let ext: string;
    if (isSvg && !isPng) {
      body = Buffer.from(
        this.sanitizeSvg(file.buffer.toString('utf8')),
        'utf8',
      );
      mime = 'image/svg+xml';
      ext = 'svg';
    } else if (isPng) {
      if (!this.looksLikePng(file.buffer)) {
        throw new BadRequestException('The file is not a valid PNG image.');
      }
      body = file.buffer;
      mime = 'image/png';
      ext = 'png';
    } else {
      throw new BadRequestException('Only SVG and PNG icons are supported.');
    }

    const hash = crypto
      .createHash('sha256')
      .update(body)
      .digest('hex')
      .slice(0, 16);
    const name = `${ICON_PREFIX}${hash}.${ext}`;

    if (!(await this.geoServer.styleResourceExists(workspace, name))) {
      await this.geoServer.putStyleResource(workspace, name, body, mime);
    }
    return { source: 'custom', name, mime };
  }

  /** Proxies a stored custom icon's bytes back (for reload preview). */
  async customIconBytes(
    workspace: string,
    name: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!name.startsWith(ICON_PREFIX) || /[\\/]/.test(name)) {
      throw new BadRequestException('Invalid icon reference.');
    }
    return this.geoServer.getStyleResource(workspace, name);
  }

  /**
   * Reverts the layer to GeoServer's built-in default style for its
   * geometry and deletes the custom style (best-effort — an orphaned
   * style is harmless).
   */
  async removeStyle(
    target: StyleTarget,
    geometry: 'point' | 'line' | 'polygon' | 'raster' | null,
  ): Promise<void> {
    const styleName =
      target.styleName ?? this.styleNameFor(target.geoserverLayer);
    await this.geoServer.setLayerDefaultStyle(
      target.workspace,
      target.geoserverLayer,
      this.builtInStyle(geometry),
    );
    await this.geoServer
      .deleteStyle(target.workspace, styleName)
      .catch((error: Error) =>
        this.logger.warn(
          `Reverted ${target.workspace}:${target.geoserverLayer} but failed to delete style "${styleName}": ${error.message}`,
        ),
      );
  }

  // ---- icons -------------------------------------------------------

  /**
   * Deep-copies `spec` and rewrites every `symbol.icon` so its `name` is a
   * workspace style-resource filename GeoServer can resolve. Builtin icons
   * are pushed to the workspace on first use; custom icons were already
   * stored by `uploadIcon`.
   */
  private async resolveSpecIcons(
    workspace: string,
    spec: LayerStyleSpecDto,
  ): Promise<LayerStyleSpecDto> {
    const clone = JSON.parse(JSON.stringify(spec)) as LayerStyleSpecDto;
    if (clone.geometry !== 'point') return clone;

    const symbols: SymbolSpecDto[] = [clone.symbol];
    for (const category of clone.categorize?.categories ?? []) {
      symbols.push(category.symbol);
    }

    for (const symbol of symbols) {
      if (!symbol?.icon) continue;
      const ref = symbol.icon;
      if (ref.source === 'builtin') {
        const resolved = await this.ensureBuiltinIcon(workspace, ref.name);
        symbol.icon = {
          source: 'custom',
          name: resolved.name,
          mime: 'image/svg+xml',
        };
        // Default the anchor to the icon's natural anchor when the user
        // hasn't overridden it (pins → tip, shapes → centre).
        if (symbol.iconAnchorX == null && symbol.iconAnchorY == null) {
          symbol.iconAnchorX = resolved.anchor[0];
          symbol.iconAnchorY = resolved.anchor[1];
        }
      } else {
        if (!ref.name.startsWith(ICON_PREFIX) || /[\\/]/.test(ref.name)) {
          throw new BadRequestException('Invalid icon reference.');
        }
      }
    }
    return clone;
  }

  private async ensureBuiltinIcon(
    workspace: string,
    id: string,
  ): Promise<{ name: string; anchor: [number, number] }> {
    if (!isBuiltinIcon(id)) {
      throw new BadRequestException(`Unknown built-in icon "${id}".`);
    }
    const bytes = readMarkerIcon(id);
    const meta = markerIcon(id);
    if (!bytes || !meta) {
      throw new BadRequestException(`Built-in icon "${id}" is unavailable.`);
    }
    const name = `${ICON_PREFIX}builtin_${id}.svg`;
    if (!(await this.geoServer.styleResourceExists(workspace, name))) {
      await this.geoServer.putStyleResource(
        workspace,
        name,
        bytes,
        'image/svg+xml',
      );
    }
    return { name, anchor: meta.anchor };
  }

  private looksLikePng(buffer: Buffer): boolean {
    return (
      buffer.length > 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    );
  }

  private looksLikeSvg(buffer: Buffer): boolean {
    return /<svg[\s>]/i.test(buffer.subarray(0, 2048).toString('utf8'));
  }

  /**
   * Validates an uploaded SVG marker: strips inert noise (XML prolog,
   * DOCTYPE, comments) then *rejects* — rather than silently repairs —
   * anything that could execute or fetch when GeoServer rasterises it with
   * Batik (scripts, event handlers, external references, embedded HTML,
   * entity definitions). A hostile upload is refused, not quietly cleaned.
   */
  private sanitizeSvg(svg: string): string {
    if (!/<svg[\s>]/i.test(svg)) {
      throw new BadRequestException('The file is not a valid SVG image.');
    }
    const out = svg
      .replace(/<\?xml[\s\S]*?\?>/gi, '')
      .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .trim();
    if (
      /<script[\s>]/i.test(out) ||
      /<foreignObject[\s>]/i.test(out) ||
      /\son\w+\s*=/i.test(out) ||
      /javascript:/i.test(out) ||
      /<!ENTITY/i.test(out) ||
      /(?:href|xlink:href)\s*=\s*["'](?!#)/i.test(out)
    ) {
      throw new BadRequestException(
        'The SVG contains scripts or external references and cannot be used as an icon.',
      );
    }
    if (Buffer.byteLength(out, 'utf8') > MAX_ICON_BYTES) {
      throw new PayloadTooLargeException('The SVG is too large.');
    }
    return out;
  }

  private builtInStyle(
    geometry: 'point' | 'line' | 'polygon' | 'raster' | null,
  ): string {
    if (geometry === 'point') return 'point';
    if (geometry === 'line') return 'line';
    if (geometry === 'raster') return 'raster';
    return 'polygon';
  }
}
