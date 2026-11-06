-- Multi-format rendering, part 2. New layers default to AUTO (fastest
-- supported format); existing layers keep rendering exactly as today.
-- Rasters were always drawn as GeoWebCache tiles: that is WMS_TILED now.
UPDATE "gis_layers" SET "render_mode" = 'WMS_TILED' WHERE "layer_type" = 'RASTER' AND "render_mode" = 'WMS';
ALTER TABLE "gis_layers" ALTER COLUMN "render_mode" SET DEFAULT 'AUTO';

-- Pre-built PMTiles archive of a layer.
CREATE TYPE "GisTileArchiveStatus" AS ENUM ('NONE', 'BUILDING', 'READY', 'FAILED');
ALTER TABLE "gis_layers"
  ADD COLUMN "pmtiles_status" "GisTileArchiveStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "pmtiles_built_at" TIMESTAMP(3),
  ADD COLUMN "pmtiles_error" TEXT;
