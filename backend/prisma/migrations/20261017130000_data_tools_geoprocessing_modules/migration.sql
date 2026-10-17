-- Module Access: catalog entries for the Data Tools / Geoprocessing /
-- Export features added on 2026-10-17, so each can be granted separately.
INSERT INTO modules (module_id, module_name, isactive, module_parent_id, node_path, sub_module, default_module, display_priority, type) VALUES
  (1017, 'Field Management (Add / Rename / Delete)', true, 1010, '1010.1017', NULL, false, 7, 'mainleft'),
  (1018, 'Calculate Geometry', true, 1010, '1010.1018', NULL, false, 8, 'mainleft'),
  (1019, 'Find & Replace', true, 1010, '1010.1019', NULL, false, 9, 'mainleft'),
  (1020, 'Auto-number IDs', true, 1010, '1010.1020', NULL, false, 10, 'mainleft'),
  (1021, 'Change Field Type', true, 1010, '1010.1021', NULL, false, 11, 'mainleft'),
  (1022, 'Standardise Values', true, 1010, '1010.1022', NULL, false, 12, 'mainleft'),
  (1023, 'Completeness Report', true, 1010, '1010.1023', NULL, false, 13, 'mainleft'),
  (1024, 'Find Duplicates', true, 1010, '1010.1024', NULL, false, 14, 'mainleft'),
  (1025, 'Append Features', true, 1010, '1010.1025', NULL, false, 15, 'mainleft'),
  (1026, 'Split Layer by Attribute', true, 1010, '1010.1026', NULL, false, 16, 'mainleft'),
  (1027, 'Change Log', true, 1010, '1010.1027', NULL, false, 17, 'mainleft'),
  (1031, 'Advanced Overlay (Symmetrical Difference, Merge)', true, 1002, '1002.1031', NULL, false, 1, 'mainleft'),
  (1032, 'Proximity Analysis (Nearest Join, Select by Location, Voronoi)', true, 1002, '1002.1032', NULL, false, 2, 'mainleft'),
  (1033, 'Geometry Tools (Centroids, Hull, Simplify, Convert …)', true, 1002, '1002.1033', NULL, false, 3, 'mainleft'),
  (1034, 'Grid Analysis (Square / Hexagon)', true, 1002, '1002.1034', NULL, false, 4, 'mainleft'),
  (1035, 'Export with Filter', true, 226, '226.1035', NULL, false, 6, 'mainleft')
ON CONFLICT (module_id) DO NOTHING;

-- Whoever already had the tool these were split out of keeps them.
WITH split(new_id, old_id) AS (VALUES
  (1017, 1011), (1018, 1011), (1019, 1011), (1020, 1011), (1021, 1011), (1022, 1011), (1025, 1011), (1026, 1011),
  (1023, 1014), (1024, 1014), (1027, 1016),
  (1031, 1002), (1032, 1002), (1033, 1002), (1034, 1002), (1035, 226))
INSERT INTO department_module_grants (id, department_id, module_id, granted_by, created_at)
SELECT gen_random_uuid()::text, g.department_id, s.new_id, g.granted_by, now()
  FROM department_module_grants g JOIN split s ON s.old_id = g.module_id
 WHERE NOT EXISTS (SELECT 1 FROM department_module_grants x WHERE x.department_id = g.department_id AND x.module_id = s.new_id);

WITH split(new_id, old_id) AS (VALUES
  (1017, 1011), (1018, 1011), (1019, 1011), (1020, 1011), (1021, 1011), (1022, 1011), (1025, 1011), (1026, 1011),
  (1023, 1014), (1024, 1014), (1027, 1016),
  (1031, 1002), (1032, 1002), (1033, 1002), (1034, 1002), (1035, 226))
INSERT INTO user_module_grants (id, user_id, module_id, granted_by, created_at)
SELECT gen_random_uuid()::text, g.user_id, s.new_id, g.granted_by, now()
  FROM user_module_grants g JOIN split s ON s.old_id = g.module_id
 WHERE NOT EXISTS (SELECT 1 FROM user_module_grants x WHERE x.user_id = g.user_id AND x.module_id = s.new_id);
