-- Module Access: the catalog's "3D Button" is now the working 3D View
-- (Cesium globe) in Map Tools.
UPDATE modules
   SET module_name = '3D View', module_parent_id = 18, node_path = '18.74', type = 'mainright', display_priority = 11
 WHERE module_id = 74;
