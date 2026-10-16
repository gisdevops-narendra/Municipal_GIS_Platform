-- CreateEnum
CREATE TYPE "GisFeatureAction" AS ENUM ('INSERT', 'UPDATE', 'DELETE');

-- CreateTable
CREATE TABLE "gis_feature_history" (
    "id" TEXT NOT NULL,
    "layer_id" TEXT NOT NULL,
    "feature_id" INTEGER NOT NULL,
    "action" "GisFeatureAction" NOT NULL,
    "old_data" JSONB,
    "new_data" JSONB,
    "user_id" TEXT,
    "user_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gis_feature_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gis_feature_history_layer_id_feature_id_idx" ON "gis_feature_history"("layer_id", "feature_id");

-- CreateIndex
CREATE INDEX "gis_feature_history_layer_id_created_at_idx" ON "gis_feature_history"("layer_id", "created_at");

-- AddForeignKey
ALTER TABLE "gis_feature_history" ADD CONSTRAINT "gis_feature_history_layer_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "gis_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
