-- Departments, Module Access, per-layer permission grants and Dashboard
-- pins were removed from the app (every account owns its own workspace).
-- Written by hand on purpose: an automatic `prisma migrate diff` would also
-- drop the runtime-created layer_* / gis_demo_* tables, which are user data.
-- The data dropped here is in the 2026-11-21 backup (backups/auto/20261121-155348).

-- Columns pointing at departments
ALTER TABLE "users"              DROP CONSTRAINT IF EXISTS "users_department_id_fkey";
ALTER TABLE "gis_layers"         DROP CONSTRAINT IF EXISTS "gis_layers_department_id_fkey";
ALTER TABLE "gis_layer_uploads"  DROP CONSTRAINT IF EXISTS "gis_layer_uploads_department_id_fkey";
DROP INDEX IF EXISTS "gis_layers_department_id_idx";
DROP INDEX IF EXISTS "gis_layer_uploads_department_id_idx";
ALTER TABLE "users"              DROP COLUMN IF EXISTS "department_id";
ALTER TABLE "gis_layers"         DROP COLUMN IF EXISTS "department_id";
ALTER TABLE "gis_layer_uploads"  DROP COLUMN IF EXISTS "department_id";
ALTER TABLE "raster_job_history" DROP COLUMN IF EXISTS "output_department_id";

-- Tables
DROP TABLE IF EXISTS "gis_layer_permissions";
DROP TABLE IF EXISTS "department_module_grants";
DROP TABLE IF EXISTS "user_module_grants";
DROP TABLE IF EXISTS "modules";
DROP TABLE IF EXISTS "departments";
DROP TABLE IF EXISTS "raster_pins";

-- Enums only those tables used
DROP TYPE IF EXISTS "DepartmentStatus";
DROP TYPE IF EXISTS "GisPermission";
