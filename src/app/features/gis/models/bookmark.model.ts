/**
 * Spatial bookmark model. Framework-free so the bookmark panel, the
 * persistence service, and any later bookmark features (sharing, folders,
 * import/export, per-bookmark visible layers) share one shape.
 */

/** Everything needed to restore an OpenLayers view. */
export interface BookmarkView {
  /** map centre, in `projection` units */
  center: [number, number];
  zoom: number;
  /** projection code the centre is expressed in, e.g. "EPSG:3857" */
  projection: string;
}

export interface Bookmark {
  id: string;
  name: string;
  createdAt: string;
  view: BookmarkView;
}

export type BookmarkError = 'empty' | 'duplicate' | 'not-found';

export type BookmarkResult =
  | { ok: true; bookmark: Bookmark }
  | { ok: false; reason: BookmarkError };
