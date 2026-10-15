-- Raster Analysis (69) catalog branch: 4 groups and the 21 planned raster
-- features under them, so they can be granted per department as each one
-- ships. Not default modules. Fixed ids (910-953) keep clear of modules
-- added through the UI (modules_module_id_seq) and match
-- prisma/seed-modules.ts. Raster Analysis itself is upserted-if-missing so
-- the branch never hangs off a deleted parent.
INSERT INTO "modules" ("module_id", "module_name", "isactive", "module_parent_id", "node_path", "sub_module", "default_module", "display_priority", "type")
VALUES
  (69, 'Raster Analysis', true, NULL, '69', NULL, false, 5, 'mainleft'),
  (910, 'Raster Data', true, 69, '69.910', NULL, false, 1, 'mainleft'),
  (920, 'Terrain Analysis', true, 69, '69.920', NULL, false, 2, 'mainleft'),
  (940, 'Raster Analytics', true, 69, '69.940', NULL, false, 3, 'mainleft'),
  (950, 'Imagery Analysis', true, 69, '69.950', NULL, false, 4, 'mainleft'),
  (911, 'Raster Upload & Publish', true, 910, '69.910.911', NULL, false, 1, 'mainleft'),
  (912, 'Raster Styling', true, 910, '69.910.912', NULL, false, 2, 'mainleft'),
  (913, 'Pixel Identify', true, 910, '69.910.913', NULL, false, 3, 'mainleft'),
  (921, 'Elevation Profile', true, 920, '69.920.921', NULL, false, 1, 'mainleft'),
  (922, 'Slope', true, 920, '69.920.922', NULL, false, 2, 'mainleft'),
  (923, 'Aspect', true, 920, '69.920.923', NULL, false, 3, 'mainleft'),
  (924, 'Hillshade', true, 920, '69.920.924', NULL, false, 4, 'mainleft'),
  (925, 'Contour Generation', true, 920, '69.920.925', NULL, false, 5, 'mainleft'),
  (926, 'Cut & Fill / Volume', true, 920, '69.920.926', NULL, false, 6, 'mainleft'),
  (927, 'Drainage / Watershed', true, 920, '69.920.927', NULL, false, 7, 'mainleft'),
  (928, 'Flood Inundation', true, 920, '69.920.928', NULL, false, 8, 'mainleft'),
  (929, 'Line of Sight', true, 920, '69.920.929', NULL, false, 9, 'mainleft'),
  (930, 'Viewshed', true, 920, '69.920.930', NULL, false, 10, 'mainleft'),
  (941, 'Zonal Statistics', true, 940, '69.940.941', NULL, false, 1, 'mainleft'),
  (942, 'Raster Calculator', true, 940, '69.940.942', NULL, false, 2, 'mainleft'),
  (943, 'Reclassify', true, 940, '69.940.943', NULL, false, 3, 'mainleft'),
  (944, 'Clip to Boundary', true, 940, '69.940.944', NULL, false, 4, 'mainleft'),
  (945, 'Raster to Vector', true, 940, '69.940.945', NULL, false, 5, 'mainleft'),
  (951, 'Swipe / Compare', true, 950, '69.950.951', NULL, false, 1, 'mainleft'),
  (952, 'NDVI / Vegetation Index', true, 950, '69.950.952', NULL, false, 2, 'mainleft'),
  (953, 'Change Detection', true, 950, '69.950.953', NULL, false, 3, 'mainleft')
ON CONFLICT ("module_id") DO NOTHING;

-- Keep "Add Module" from ever handing out an id at or below these.
SELECT setval('modules_module_id_seq', GREATEST((SELECT MAX("module_id") FROM "modules") + 1, (SELECT last_value FROM modules_module_id_seq)), false);
