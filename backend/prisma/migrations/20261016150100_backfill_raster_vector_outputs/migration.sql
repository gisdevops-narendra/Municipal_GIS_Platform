-- Vector outputs of Raster Analysis made before provenance was recorded
-- (contours, watersheds, polygonize…): they have their own PostGIS table
-- but, unlike uploaded layers, no source upload.
UPDATE "gis_layers"
SET "raster_analysis" = true
WHERE "layer_type" = 'VECTOR'
  AND "postgis_table" IS NOT NULL
  AND "source_upload_id" IS NULL;
