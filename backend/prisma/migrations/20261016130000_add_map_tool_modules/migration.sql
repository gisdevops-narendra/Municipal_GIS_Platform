-- Module Access: give every GIS map feature a catalog entry.
--   960 Workspace Details (left rail tool)
--   961 Reset View, 962 Fullscreen (map controls, under 18 Map Tools)
--   963 Overlay (Buffer & Overlay tool, under 6 Buffer)
--   32  Draw (Draw & Mark tool shapes, under 73 Marking Tool)
INSERT INTO modules (module_id, module_name, isactive, module_parent_id, node_path, sub_module, default_module, display_priority, type) VALUES
  (960, 'Workspace Details', true, NULL, '960', NULL, false, 13, 'mainleft'),
  (961, 'Reset View', true, 18, '18.961', NULL, true, 3, 'mainright'),
  (962, 'Fullscreen', true, 18, '18.962', NULL, true, 4, 'mainright'),
  (963, 'Overlay', true, 6, '2.6.963', NULL, false, 2, 'mainleft'),
  (32, 'Draw', true, 73, '73.32', NULL, false, 1, 'mainleft')
ON CONFLICT (module_id) DO NOTHING;

-- Map Tools order: Zoom In, Zoom Out, Reset View, Fullscreen, Pan, Nav History,
-- Go To X:Y, Information Tool, Selection Tool, Basemap, Free Search.
UPDATE modules SET display_priority = 5  WHERE module_id = 21;
UPDATE modules SET display_priority = 6  WHERE module_id = 59;
UPDATE modules SET display_priority = 7  WHERE module_id = 12;
UPDATE modules SET display_priority = 8  WHERE module_id = 58;
UPDATE modules SET display_priority = 9  WHERE module_id = 57;
UPDATE modules SET display_priority = 10 WHERE module_id = 17;
UPDATE modules SET display_priority = 11 WHERE module_id = 30;

-- Keep auto-numbered modules (POST /module-access/catalog) clear of these ids.
SELECT setval('modules_module_id_seq', GREATEST((SELECT max(module_id) FROM modules) + 1, nextval('modules_module_id_seq')), false);
