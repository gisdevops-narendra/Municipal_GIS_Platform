-- Groundwater monitoring: water-level readings per well feature.
CREATE TABLE "gis_well_readings" (
    "id" TEXT NOT NULL,
    "layer_id" TEXT NOT NULL,
    "feature_id" INTEGER NOT NULL,
    "reading_date" DATE NOT NULL,
    "depth_m" DOUBLE PRECISION NOT NULL,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "gis_well_readings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gis_well_readings_layer_id_feature_id_reading_date_idx" ON "gis_well_readings"("layer_id", "feature_id", "reading_date");
ALTER TABLE "gis_well_readings" ADD CONSTRAINT "gis_well_readings_layer_id_fkey"
    FOREIGN KEY ("layer_id") REFERENCES "gis_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
