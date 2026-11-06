-- Per-layer rendering mode for the Geoportal. Every layer (existing and
-- new) starts as plain WMS; tiled WMS (GeoWebCache) and vector tiles (MVT)
-- are opt-in per layer.
CREATE TYPE "GisRenderMode" AS ENUM ('WMS', 'WMS_TILED', 'MVT');
ALTER TABLE "gis_layers" ADD COLUMN "render_mode" "GisRenderMode" NOT NULL DEFAULT 'WMS';
