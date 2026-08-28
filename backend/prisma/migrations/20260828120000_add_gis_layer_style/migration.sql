-- GIS Layer Styling (GeoServer + YSLD).
--
-- Hand-written (same convention as the Task 6/7/8 GIS migrations): a plain
-- `prisma migrate diff` against this database also proposes dropping the
-- unmanaged runtime tables (`gis_demo_*`, GDAL-created `layer_<uuid>`) and
-- re-adding their GIST indexes — recurring false positives, omitted here.
-- This migration only adds the three new nullable columns.

-- AlterTable
ALTER TABLE "gis_layers"
  ADD COLUMN "style_name" TEXT,
  ADD COLUMN "style_spec" JSONB;

-- AlterTable
ALTER TABLE "gis_layer_uploads"
  ADD COLUMN "style_spec" JSONB;
