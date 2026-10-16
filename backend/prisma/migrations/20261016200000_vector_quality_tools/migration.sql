-- Fuzzy address matching (Geocoding)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable
ALTER TABLE "gis_layers" ADD COLUMN "field_rules" JSONB;

-- CreateTable
CREATE TABLE "gis_feature_attachments" (
    "id" TEXT NOT NULL,
    "layer_id" TEXT NOT NULL,
    "feature_id" INTEGER NOT NULL,
    "file_name" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gis_feature_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gis_layer_snapshots" (
    "id" TEXT NOT NULL,
    "layer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "postgis_table" TEXT NOT NULL,
    "feature_count" INTEGER NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gis_layer_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gis_feature_attachments_layer_id_feature_id_idx" ON "gis_feature_attachments"("layer_id", "feature_id");

-- CreateIndex
CREATE INDEX "gis_layer_snapshots_layer_id_idx" ON "gis_layer_snapshots"("layer_id");

-- AddForeignKey
ALTER TABLE "gis_feature_attachments" ADD CONSTRAINT "gis_feature_attachments_layer_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "gis_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_snapshots" ADD CONSTRAINT "gis_layer_snapshots_layer_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "gis_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
