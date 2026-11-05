import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  BuiltinIcon,
  ClassificationMethod,
  FieldStats,
  IconRef,
  LayerStyleSpec,
  StyleAttribute,
  StyleGeometry,
  StyleTargetRef,
} from '../models/layer-style.model';

export interface StyleAttributesResponse {
  geometry: StyleGeometry | null;
  attributes: StyleAttribute[];
}

export interface SldCheckResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Workspace-qualified draft style the map can render as a preview. */
  previewStyle: string | null;
}

export interface StoredStyle {
  styleName: string | null;
  spec: LayerStyleSpec | null;
  geometry?: StyleGeometry | null;
  /** The active style is an uploaded SLD (no editor spec). */
  sld?: boolean;
}

/**
 * Talks to `/api/gis/(layers|uploads)/:id/style*`. The backend owns the
 * YSLD generation, GeoServer persistence and tenant/permission checks —
 * this service just carries the structured spec and the classification
 * queries for the style editor.
 */
@Injectable({ providedIn: 'root' })
export class LayerStyleService {
  private readonly http = inject(HttpClient);
  private readonly api = `${environment.apiUrl}/gis`;

  private base(target: StyleTargetRef): string {
    return `${this.api}/${target.kind === 'layer' ? 'layers' : 'uploads'}/${target.id}/style`;
  }

  /** Only meaningful for `kind: 'layer'` — uploads have no saved style yet. */
  getStyle(target: StyleTargetRef): Observable<StoredStyle> {
    return this.http.get<StoredStyle>(this.base(target));
  }

  attributes(target: StyleTargetRef): Observable<StyleAttributesResponse> {
    return this.http.get<StyleAttributesResponse>(
      `${this.base(target)}/attributes`,
    );
  }

  fieldStats(
    target: StyleTargetRef,
    field: string,
    method?: ClassificationMethod,
    classes?: number,
  ): Observable<FieldStats> {
    const params: Record<string, string> = { field };
    if (method) params['method'] = method;
    if (classes != null) params['classes'] = String(classes);
    return this.http.get<FieldStats>(`${this.base(target)}/field-stats`, {
      params,
    });
  }

  /** Apply = generate YSLD, save it in GeoServer, set it as the layer
   *  default (layer target) / restyle the preview featuretype (upload
   *  target) and stash the spec. */
  apply(
    target: StyleTargetRef,
    spec: LayerStyleSpec,
  ): Observable<{ styleName?: string; spec?: LayerStyleSpec }> {
    return this.http.put<{ styleName?: string; spec?: LayerStyleSpec }>(
      this.base(target),
      spec,
    );
  }

  /** Layer target only — revert to GeoServer's built-in default style. */
  remove(target: StyleTargetRef): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(this.base(target));
  }

  /** Layer target only — upload an SLD file as the layer's style. */
  uploadSld(target: StyleTargetRef, file: File): Observable<{ styleName: string }> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ styleName: string }>(`${this.base(target)}/sld`, form);
  }

  /** Layer target only — apply pasted SLD text as the layer's style. */
  pasteSld(target: StyleTargetRef, sld: string): Observable<{ styleName: string }> {
    return this.http.put<{ styleName: string }>(`${this.base(target)}/sld`, { sld });
  }

  /** Layer target only — validate SLD (platform, GeoServer and attribute
   *  checks) and stage it as a draft style the map can preview. */
  checkSld(target: StyleTargetRef, sld: string): Observable<SldCheckResult> {
    return this.http.post<SldCheckResult>(`${this.base(target)}/sld/check`, { sld });
  }

  /** Layer target only — drop the staged SLD draft. */
  discardSldDraft(target: StyleTargetRef): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.base(target)}/sld/draft`);
  }

  /** Layer target only — the current style as SLD text. */
  currentSld(target: StyleTargetRef): Observable<string> {
    return this.http.get(`${this.base(target)}/sld`, { responseType: 'text' });
  }

  /** Layer target only — the current style as an SLD file. */
  downloadSld(target: StyleTargetRef): Observable<Blob> {
    return this.http.get(`${this.base(target)}/sld`, { responseType: 'blob' });
  }

  // ---- point icons (ExternalGraphic) ------------------------------

  /** The bundled marker-icon gallery (CC0 — attribution not required). */
  builtinIcons(): Observable<{ icons: BuiltinIcon[] }> {
    return this.http.get<{ icons: BuiltinIcon[] }>(`${this.api}/style/icons`);
  }

  /** URL for a built-in icon's SVG (for `<img>` thumbnails + map preview). */
  builtinIconUrl(id: string): string {
    return `${this.api}/style/icons/${encodeURIComponent(id)}`;
  }

  /** URL for a previously uploaded custom icon, proxied from GeoServer.
   *  This route is tenant-scoped and needs the JWT, so it can't be used as
   *  a plain `<img src>` — fetch it with {@link customIconBlob} instead. */
  customIconUrl(target: StyleTargetRef, name: string): string {
    return `${this.base(target)}/icon/${encodeURIComponent(name)}`;
  }

  /** Bytes of an uploaded custom icon (for an object-URL `<img>` preview). */
  customIconBlob(target: StyleTargetRef, name: string): Observable<Blob> {
    return this.http.get(this.customIconUrl(target, name), {
      responseType: 'blob',
    });
  }

  /** Upload a user SVG/PNG icon; resolves to the `IconRef` to store on the
   *  symbol spec. */
  uploadIcon(target: StyleTargetRef, file: File): Observable<IconRef> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<IconRef>(`${this.base(target)}/icon`, form);
  }
}
