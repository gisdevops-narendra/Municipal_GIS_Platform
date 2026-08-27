-- Enable PostGIS. On a brand-new database the postgis/postgis Docker
-- image's init scripts already ran this; IF NOT EXISTS makes it a no-op
-- there and idempotent everywhere else (e.g. upgrading an existing Task
-- 3/4 database whose data directory predates the PostGIS image, where
-- those init scripts do NOT re-run).
CREATE EXTENSION IF NOT EXISTS postgis;

-- CreateEnum
CREATE TYPE "GisWorkspaceStatus" AS ENUM ('PROVISIONING', 'ACTIVE', 'PROVISIONING_FAILED');

-- CreateTable
CREATE TABLE "gis_workspaces" (
    "id" TEXT NOT NULL,
    "municipality_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "status" "GisWorkspaceStatus" NOT NULL DEFAULT 'PROVISIONING',
    "default_crs" TEXT NOT NULL DEFAULT 'EPSG:32643',
    "display_crs" TEXT NOT NULL DEFAULT 'EPSG:4326',
    "geoserver_workspace" TEXT NOT NULL,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gis_workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gis_workspaces_municipality_id_key" ON "gis_workspaces"("municipality_id");

-- CreateIndex
CREATE UNIQUE INDEX "gis_workspaces_geoserver_workspace_key" ON "gis_workspaces"("geoserver_workspace");

-- AddForeignKey
ALTER TABLE "gis_workspaces" ADD CONSTRAINT "gis_workspaces_municipality_id_fkey" FOREIGN KEY ("municipality_id") REFERENCES "municipalities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
