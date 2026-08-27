-- CreateEnum
CREATE TYPE "GisLayerType" AS ENUM ('VECTOR', 'RASTER');

-- CreateEnum
CREATE TYPE "GisGeometryType" AS ENUM ('POINT', 'LINE', 'POLYGON');

-- CreateEnum
CREATE TYPE "GisLayerStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateTable
CREATE TABLE "gis_layers" (
    "id" TEXT NOT NULL,
    "gis_workspace_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "layer_type" "GisLayerType" NOT NULL DEFAULT 'VECTOR',
    "geoserver_workspace" TEXT NOT NULL,
    "geoserver_layer" TEXT NOT NULL,
    "geometry_type" "GisGeometryType",
    "visible_by_default" BOOLEAN NOT NULL DEFAULT true,
    "status" "GisLayerStatus" NOT NULL DEFAULT 'ACTIVE',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "bbox_min_x" DOUBLE PRECISION,
    "bbox_min_y" DOUBLE PRECISION,
    "bbox_max_x" DOUBLE PRECISION,
    "bbox_max_y" DOUBLE PRECISION,
    "created_by" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gis_layers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gis_layers_gis_workspace_id_code_key" ON "gis_layers"("gis_workspace_id", "code");

-- AddForeignKey
ALTER TABLE "gis_layers" ADD CONSTRAINT "gis_layers_gis_workspace_id_fkey" FOREIGN KEY ("gis_workspace_id") REFERENCES "gis_workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- Task 6: demo PostGIS feature tables.
--
-- These are NOT modeled in schema.prisma / Prisma Client on purpose — they
-- are raw geometry storage that GeoServer publishes directly (see
-- docs/backend.md "GIS Layers"). Prisma/Postgres only tracks GISLayer
-- *metadata* (the row above's sibling table); the actual features live
-- here. All three are tagged "DEMO DATA" in their name/comment and are
-- explicitly the demonstration layers from Task 6 §7 — not real municipal
-- data.
--
-- `gis_workspace_id` is a plain TEXT FK (not a Prisma relation) shared by
-- every municipality's rows in the SAME physical table — each municipality's
-- GeoServer featuretype is published with a CQL default filter scoping it
-- to its own gis_workspace_id, so tenant isolation is enforced by GeoServer
-- itself at the OGC-service level, not just by our own API's row filtering.
-- Storage SRID is 32643 to match GISWorkspace.defaultCrs (Task 5 §18) — do
-- not change without also changing the workspace CRS strategy.
-- ============================================================================

CREATE TABLE "gis_demo_municipal_boundary" (
    "id" SERIAL PRIMARY KEY,
    "gis_workspace_id" TEXT NOT NULL REFERENCES "gis_workspaces"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "geom" geometry(MultiPolygon, 32643) NOT NULL
);
CREATE INDEX "gis_demo_municipal_boundary_geom_idx" ON "gis_demo_municipal_boundary" USING GIST ("geom");
CREATE INDEX "gis_demo_municipal_boundary_workspace_idx" ON "gis_demo_municipal_boundary" ("gis_workspace_id");
COMMENT ON TABLE "gis_demo_municipal_boundary" IS 'Task 6 DEMO DATA — not real municipal boundary data.';

CREATE TABLE "gis_demo_wards" (
    "id" SERIAL PRIMARY KEY,
    "gis_workspace_id" TEXT NOT NULL REFERENCES "gis_workspaces"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "ward_number" INTEGER,
    "geom" geometry(MultiPolygon, 32643) NOT NULL
);
CREATE INDEX "gis_demo_wards_geom_idx" ON "gis_demo_wards" USING GIST ("geom");
CREATE INDEX "gis_demo_wards_workspace_idx" ON "gis_demo_wards" ("gis_workspace_id");
COMMENT ON TABLE "gis_demo_wards" IS 'Task 6 DEMO DATA — not real ward boundary data.';

CREATE TABLE "gis_demo_roads" (
    "id" SERIAL PRIMARY KEY,
    "gis_workspace_id" TEXT NOT NULL REFERENCES "gis_workspaces"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "road_type" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Active',
    "geom" geometry(MultiLineString, 32643) NOT NULL
);
CREATE INDEX "gis_demo_roads_geom_idx" ON "gis_demo_roads" USING GIST ("geom");
CREATE INDEX "gis_demo_roads_workspace_idx" ON "gis_demo_roads" ("gis_workspace_id");
COMMENT ON TABLE "gis_demo_roads" IS 'Task 6 DEMO DATA — not real road data.';
