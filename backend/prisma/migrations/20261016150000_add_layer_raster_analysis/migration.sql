-- Raster Analysis results get their own group in the Layers panel.
ALTER TABLE "gis_layers" ADD COLUMN "raster_analysis" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: every raster, and every vector layer a Raster Analysis tool
-- wrote its provenance into.
UPDATE "gis_layers"
SET "raster_analysis" = true
WHERE "layer_type" = 'RASTER' OR "description" LIKE 'Raster Analysis ·%';
