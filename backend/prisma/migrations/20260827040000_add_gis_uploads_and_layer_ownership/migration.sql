-- Task 7: GIS data upload, validation, draft/review/publish workflow.
--
-- This file is a hand-edited version of `prisma migrate diff`'s output.
-- The raw diff also proposed dropping gis_demo_municipal_boundary,
-- gis_demo_wards, and gis_demo_roads (and their FKs) — those tables are
-- real, non-empty Task 6 demo data, but Prisma does not model them (they
-- were created via raw SQL in the Task 6 migration, see
-- 20260826123731_add_gis_layers_and_demo_tables), so `prisma migrate diff`
-- sees them as "extraneous" relative to schema.prisma and proposes
-- dropping them. Those DROP TABLE / DROP CONSTRAINT statements have been
-- removed from this file — see docs/backend.md "GIS Uploads" for why.

-- CreateEnum
CREATE TYPE "GisLayerOwnershipType" AS ENUM ('CANONICAL', 'DEPARTMENT');

-- CreateEnum
CREATE TYPE "GisUploadFileFormat" AS ENUM ('SHAPEFILE_ZIP', 'GEOJSON', 'CSV');

-- CreateEnum
CREATE TYPE "GisUploadStatus" AS ENUM ('UPLOAD_PENDING', 'VALIDATING', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'REJECTED', 'FAILED', 'PUBLISH_FAILED');

-- AlterTable
ALTER TABLE "gis_layers" ADD COLUMN     "department_id" TEXT,
ADD COLUMN     "ownership_type" "GisLayerOwnershipType" NOT NULL DEFAULT 'CANONICAL',
ADD COLUMN     "postgis_table" TEXT,
ADD COLUMN     "source_upload_id" TEXT,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "gis_layer_uploads" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "gis_workspace_id" TEXT NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "stored_filename" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "file_format" "GisUploadFileFormat" NOT NULL,
    "status" "GisUploadStatus" NOT NULL DEFAULT 'UPLOAD_PENDING',
    "layer_name" TEXT NOT NULL,
    "layer_code" TEXT NOT NULL,
    "description" TEXT,
    "department_id" TEXT,
    "ownership_type" "GisLayerOwnershipType" NOT NULL DEFAULT 'DEPARTMENT',
    "source_crs" TEXT,
    "target_crs" TEXT,
    "geometry_type" "GisGeometryType",
    "feature_count" INTEGER,
    "postgis_table" TEXT,
    "validation_summary" JSONB,
    "error_message" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "rejection_reason" TEXT,
    "published_by" TEXT,
    "published_at" TIMESTAMP(3),
    "layer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gis_layer_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gis_layer_uploads_municipality_id_status_idx" ON "gis_layer_uploads"("municipality_id", "status");

-- CreateIndex
CREATE INDEX "gis_layer_uploads_department_id_idx" ON "gis_layer_uploads"("department_id");

-- CreateIndex
CREATE INDEX "gis_layers_department_id_idx" ON "gis_layers"("department_id");

-- AddForeignKey
ALTER TABLE "gis_layers" ADD CONSTRAINT "gis_layers_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_uploads" ADD CONSTRAINT "gis_layer_uploads_municipality_id_fkey" FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_uploads" ADD CONSTRAINT "gis_layer_uploads_gis_workspace_id_fkey" FOREIGN KEY ("gis_workspace_id") REFERENCES "gis_workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_uploads" ADD CONSTRAINT "gis_layer_uploads_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_uploads" ADD CONSTRAINT "gis_layer_uploads_layer_id_fkey" FOREIGN KEY ("layer_id") REFERENCES "gis_layers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
