-- Upload Columns step: approved column meanings + schema change log.
ALTER TABLE "gis_layer_uploads" ADD COLUMN "field_metadata" JSONB;
ALTER TABLE "gis_layer_uploads" ADD COLUMN "schema_changes" JSONB;
ALTER TABLE "gis_layer_uploads" ADD COLUMN "schema_confirmed_at" TIMESTAMP(3);
