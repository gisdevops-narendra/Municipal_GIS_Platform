-- Lets the Owner's "Add Module" flow (POST /api/module-access/catalog)
-- insert a new module without choosing an id itself. The seed script
-- (prisma/seed-modules.ts) keeps using its own explicit client-supplied
-- ids via upsert, so the sequence is seeded to start strictly after the
-- highest id already in the table -- no collision with existing or
-- future seed rows is possible.
CREATE SEQUENCE IF NOT EXISTS "modules_module_id_seq" OWNED BY "modules"."module_id";

SELECT setval('modules_module_id_seq', COALESCE((SELECT MAX(module_id) FROM "modules"), 0));

ALTER TABLE "modules" ALTER COLUMN "module_id" SET DEFAULT nextval('modules_module_id_seq');
