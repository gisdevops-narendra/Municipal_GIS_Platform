-- Task 8: replace MUNICIPALITY_USER with DEPARTMENT_HEAD/DEPARTMENT_USER,
-- add GIS layer-level permissions.
--
-- This file is a hand-edited version of `prisma migrate diff`'s output,
-- generated against a disposable shadow database (prisma_shadow_task8,
-- created and dropped on the same Postgres server — NEVER the real
-- DATABASE_URL). Two problems in the raw diff were fixed here after review
-- (per Task 8 §13's explicit "inspect generated migration SQL"):
--
-- 1. The raw diff blindly cast every existing "system_role" value from
--    the old enum to the new one via `::text::"SystemRole_new"`. The new
--    enum has no 'MUNICIPALITY_USER' value, so this would fail outright
--    against the real (non-empty) users table — there is a live
--    MUNICIPALITY_USER row (staff@somnath.gov.in) in this database. The
--    CASE expression below maps MUNICIPALITY_USER -> DEPARTMENT_USER as
--    part of the same type-conversion statement, migrating existing data
--    atomically instead of requiring a second migration.
-- 2. The raw diff also emitted `ALTER TABLE "gis_layer_permissions" ALTER
--    COLUMN "role" TYPE ...` — but gis_layer_permissions doesn't exist
--    yet at that point in the same migration (it's created later in this
--    same file); that statement would fail with "relation does not
--    exist" and has been removed. The table is simply created with the
--    correct final "role" "SystemRole" type directly.
--
-- The raw diff also proposed dropping gis_demo_municipal_boundary,
-- gis_demo_wards, and gis_demo_roads (Task 6 demo data, unmanaged by
-- Prisma) — same recurring false-positive as the Task 6/7 migrations;
-- those statements are omitted here too.

-- CreateEnum
CREATE TYPE "GisPermission" AS ENUM ('VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE');

-- AlterEnum: recreate SystemRole with exactly 3 values, migrating any
-- existing MUNICIPALITY_USER row to DEPARTMENT_USER as part of the same
-- statement.
BEGIN;
CREATE TYPE "SystemRole_new" AS ENUM ('MUNICIPALITY_OWNER', 'DEPARTMENT_HEAD', 'DEPARTMENT_USER');
ALTER TABLE "users" ALTER COLUMN "system_role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "system_role" TYPE "SystemRole_new" USING (
  CASE "system_role"::text
    WHEN 'MUNICIPALITY_USER' THEN 'DEPARTMENT_USER'
    ELSE "system_role"::text
  END::"SystemRole_new"
);
ALTER TYPE "SystemRole" RENAME TO "SystemRole_old";
ALTER TYPE "SystemRole_new" RENAME TO "SystemRole";
DROP TYPE "SystemRole_old";
ALTER TABLE "users" ALTER COLUMN "system_role" SET DEFAULT 'MUNICIPALITY_OWNER';
COMMIT;

-- CreateTable
CREATE TABLE "gis_layer_permissions" (
    "id" TEXT NOT NULL,
    "gis_layer_id" TEXT NOT NULL,
    "department_id" TEXT NOT NULL,
    "role" "SystemRole" NOT NULL,
    "permission" "GisPermission" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gis_layer_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "gis_layer_permissions_department_id_idx" ON "gis_layer_permissions"("department_id");

-- CreateIndex
CREATE UNIQUE INDEX "gis_layer_permissions_gis_layer_id_department_id_role_permi_key" ON "gis_layer_permissions"("gis_layer_id", "department_id", "role", "permission");

-- AddForeignKey
ALTER TABLE "gis_layer_permissions" ADD CONSTRAINT "gis_layer_permissions_gis_layer_id_fkey" FOREIGN KEY ("gis_layer_id") REFERENCES "gis_layers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gis_layer_permissions" ADD CONSTRAINT "gis_layer_permissions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
