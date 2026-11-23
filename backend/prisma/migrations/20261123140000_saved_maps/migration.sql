-- Saved maps: a named map state (view, basemap, visible layers, order,
-- opacity) a user can reopen; optionally shared with the municipality.
CREATE TABLE "gis_saved_maps" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "created_by" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "state" JSONB NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "gis_saved_maps_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "gis_saved_maps_municipality_id_idx" ON "gis_saved_maps"("municipality_id");
ALTER TABLE "gis_saved_maps" ADD CONSTRAINT "gis_saved_maps_municipality_id_fkey"
  FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
