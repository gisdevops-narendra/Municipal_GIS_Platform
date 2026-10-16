-- Module Access: GeoJSON export gets its own module like CSV/Shapefile/KML,
-- so every Export Data format can be granted separately.
INSERT INTO modules (module_id, module_name, isactive, module_parent_id, node_path, sub_module, default_module, display_priority, type) VALUES
  (231, 'Export to GeoJSON', true, 226, '226.231', NULL, false, 1, 'mainleft')
ON CONFLICT (module_id) DO NOTHING;

UPDATE modules SET display_priority = 2 WHERE module_id = 227;
UPDATE modules SET display_priority = 3 WHERE module_id = 228;
UPDATE modules SET display_priority = 4 WHERE module_id = 230;
