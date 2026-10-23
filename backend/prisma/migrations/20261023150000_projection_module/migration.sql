-- Module Access: the Projection data tool (reproject a layer, define its
-- CRS). Whoever already has the Field Calculator keeps parity with it.
INSERT INTO modules (module_id, module_name, isactive, module_parent_id, node_path, sub_module, default_module, display_priority, type) VALUES
  (1028, 'Projection (Reproject / Define CRS)', true, 1010, '1010.1028', NULL, false, 18, 'mainleft')
ON CONFLICT (module_id) DO NOTHING;

INSERT INTO department_module_grants (id, department_id, module_id, granted_by, created_at)
SELECT gen_random_uuid()::text, g.department_id, 1028, g.granted_by, now()
  FROM department_module_grants g
 WHERE g.module_id = 1011
   AND NOT EXISTS (SELECT 1 FROM department_module_grants x WHERE x.department_id = g.department_id AND x.module_id = 1028);

INSERT INTO user_module_grants (id, user_id, module_id, granted_by, created_at)
SELECT gen_random_uuid()::text, g.user_id, 1028, g.granted_by, now()
  FROM user_module_grants g
 WHERE g.module_id = 1011
   AND NOT EXISTS (SELECT 1 FROM user_module_grants x WHERE x.user_id = g.user_id AND x.module_id = 1028);
