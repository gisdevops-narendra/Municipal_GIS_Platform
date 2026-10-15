-- Two GIS workspace features that had no Module Access catalog entry, so
-- they could not be granted or withheld per department:
--   900 AI Assistant  (left tool rail)
--   901 Layer Styling (style editor, from the Layers panel / GIS Layers page)
-- Not default modules: Department Heads/Users get them only once granted.
-- Fixed, high ids keep them clear of modules added through the UI (which
-- take ids from modules_module_id_seq) and match prisma/seed-modules.ts.
INSERT INTO "modules" ("module_id", "module_name", "isactive", "module_parent_id", "node_path", "sub_module", "default_module", "display_priority", "type")
VALUES
  (900, 'AI Assistant', true, NULL, '900', NULL, false, NULL, 'mainleft'),
  (901, 'Layer Styling', true, NULL, '901', NULL, false, NULL, 'other')
ON CONFLICT ("module_id") DO NOTHING;

-- Keep "Add Module" from ever handing out an id at or below these.
SELECT setval('modules_module_id_seq', GREATEST((SELECT MAX("module_id") FROM "modules") + 1, (SELECT last_value FROM modules_module_id_seq)), false);
