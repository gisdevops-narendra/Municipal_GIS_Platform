-- Department roles, revised:
--   * DEPARTMENT_HEAD reviews/approves uploads, publishes and manages their
--     own department's GIS data -> default grants VIEW, UPLOAD, APPROVE,
--     PUBLISH, EXPORT, MANAGE on their department's layers.
--   * DEPARTMENT_USER only views/visualizes GIS data -> VIEW only (now
--     enforced in GisAuthorizationService regardless of grant rows).
--
-- Brings existing DEPARTMENT layers in line with the new defaults. New
-- layers get them from GisAuthorizationService.ensureDefaultPermissions.

-- Give each layer's own department Head the new default grants.
INSERT INTO "gis_layer_permissions" ("id", "gis_layer_id", "department_id", "role", "permission", "created_at", "updated_at")
SELECT gen_random_uuid()::text, l."id", l."department_id", 'DEPARTMENT_HEAD', p.permission, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "gis_layers" l
CROSS JOIN (VALUES ('VIEW'::"GisPermission"), ('UPLOAD'), ('APPROVE'), ('PUBLISH'), ('EXPORT'), ('MANAGE')) AS p(permission)
WHERE l."ownership_type" = 'DEPARTMENT' AND l."department_id" IS NOT NULL
ON CONFLICT ("gis_layer_id", "department_id", "role", "permission") DO NOTHING;

-- Department Users are view-only: drop any non-VIEW grant they held.
DELETE FROM "gis_layer_permissions"
WHERE "role" = 'DEPARTMENT_USER' AND "permission" <> 'VIEW';
