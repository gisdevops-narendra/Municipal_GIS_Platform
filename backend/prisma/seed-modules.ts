/**
 * One-time, idempotent script: seeds the global Module Access catalog —
 * every application module/tool (Pan, Measure, Basemap, Export to CSV,
 * ...) and its position in the hierarchy (`nodePath`/`parentId`). Shared
 * across every municipality, not tenant-scoped — see schema.prisma
 * `Module`. Not created/edited through the API; this script is the only
 * way the catalog is written, and it's safe to re-run (upsert by id).
 *
 * Usage: `npm run seed:modules` (from backend/).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface ModuleSeed {
  module_id: number;
  module_name: string;
  isactive: boolean;
  module_parent_id: number | null;
  node_path: string | null;
  sub_module: string | null;
  default_module: boolean | null;
  display_priority: number | null;
  type: string | null;
}

const MODULES: ModuleSeed[] = [
  { module_id: 1, module_name: 'Layers', isactive: true, module_parent_id: null, node_path: '1', sub_module: null, default_module: true, display_priority: 1, type: 'mainleft' },
  { module_id: 901, module_name: 'Layer Styling', isactive: true, module_parent_id: 1, node_path: '1.901', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 15, module_name: 'Attribute Table', isactive: true, module_parent_id: null, node_path: '15', sub_module: null, default_module: true, display_priority: 2, type: 'bottomhorizontal' },
  { module_id: 900, module_name: 'AI Assistant', isactive: true, module_parent_id: null, node_path: '900', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 4, module_name: 'Bookmark', isactive: true, module_parent_id: null, node_path: '4', sub_module: null, default_module: null, display_priority: 4, type: 'mainleft' },
  { module_id: 2, module_name: 'Query Module', isactive: true, module_parent_id: null, node_path: '2', sub_module: null, default_module: null, display_priority: 5, type: 'mainleft' },
  { module_id: 50, module_name: 'Attribute Query', isactive: true, module_parent_id: 2, node_path: '2.50', sub_module: null, default_module: null, display_priority: 1, type: 'mainleft' },
  { module_id: 16, module_name: 'Spatial Query', isactive: true, module_parent_id: 2, node_path: '2.16', sub_module: null, default_module: null, display_priority: 2, type: 'mainleft' },
  { module_id: 6, module_name: 'Buffer', isactive: true, module_parent_id: 2, node_path: '2.6', sub_module: null, default_module: null, display_priority: 3, type: 'mainleft' },
  { module_id: 187, module_name: 'MultiBuffer', isactive: true, module_parent_id: 6, node_path: '2.6.187', sub_module: null, default_module: null, display_priority: 1, type: 'mainleft' },
  { module_id: 1003, module_name: 'Impact Report', isactive: true, module_parent_id: 6, node_path: '2.6.1003', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 963, module_name: 'Overlay', isactive: true, module_parent_id: 6, node_path: '2.6.963', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 11, module_name: 'Measure', isactive: true, module_parent_id: null, node_path: '11', sub_module: null, default_module: true, display_priority: 6, type: 'mainleft' },
  { module_id: 73, module_name: 'Marking Tool', isactive: true, module_parent_id: null, node_path: '73', sub_module: null, default_module: null, display_priority: 7, type: 'mainleft' },
  { module_id: 32, module_name: 'Draw', isactive: true, module_parent_id: 73, node_path: '73.32', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 186, module_name: 'Analytics', isactive: true, module_parent_id: null, node_path: '186', sub_module: null, default_module: null, display_priority: 8, type: 'bottomhorizontal' },
  { module_id: 229, module_name: 'Data Visualisation', isactive: true, module_parent_id: 186, node_path: '186.229', sub_module: null, default_module: null, display_priority: 1, type: 'bottomhorizontal' },
  { module_id: 3, module_name: 'Print', isactive: true, module_parent_id: null, node_path: '3', sub_module: null, default_module: true, display_priority: 9, type: 'mainleft' },
  { module_id: 251, module_name: 'Report Generation', isactive: true, module_parent_id: null, node_path: '251', sub_module: null, default_module: null, display_priority: 10, type: 'bottomhorizontal' },
  { module_id: 226, module_name: 'Export Data', isactive: true, module_parent_id: null, node_path: '226', sub_module: null, default_module: null, display_priority: 11, type: 'mainleft' },
  { module_id: 231, module_name: 'Export to GeoJSON', isactive: true, module_parent_id: 226, node_path: '226.231', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 227, module_name: 'Export to csv', isactive: true, module_parent_id: 226, node_path: '226.227', sub_module: null, default_module: null, display_priority: 2, type: 'mainleft' },
  { module_id: 228, module_name: 'Export to shapefile', isactive: true, module_parent_id: 226, node_path: '226.228', sub_module: null, default_module: null, display_priority: 3, type: 'mainleft' },
  { module_id: 230, module_name: 'Export to kml', isactive: true, module_parent_id: 226, node_path: '226.230', sub_module: null, default_module: null, display_priority: 4, type: 'mainleft' },
  { module_id: 18, module_name: 'Map Tools', isactive: true, module_parent_id: null, node_path: '18', sub_module: null, default_module: true, display_priority: 12, type: 'mainright' },
  { module_id: 19, module_name: 'Zoom In', isactive: true, module_parent_id: 18, node_path: '18.19', sub_module: null, default_module: true, display_priority: 1, type: 'mainright' },
  { module_id: 20, module_name: 'Zoom Out', isactive: true, module_parent_id: 18, node_path: '18.20', sub_module: null, default_module: true, display_priority: 2, type: 'mainright' },
  { module_id: 961, module_name: 'Reset View', isactive: true, module_parent_id: 18, node_path: '18.961', sub_module: null, default_module: true, display_priority: 3, type: 'mainright' },
  { module_id: 962, module_name: 'Fullscreen', isactive: true, module_parent_id: 18, node_path: '18.962', sub_module: null, default_module: true, display_priority: 4, type: 'mainright' },
  { module_id: 21, module_name: 'Pan', isactive: true, module_parent_id: 18, node_path: '18.21', sub_module: null, default_module: true, display_priority: 5, type: 'mainright' },
  { module_id: 59, module_name: 'Nav History', isactive: true, module_parent_id: 18, node_path: '18.59', sub_module: null, default_module: null, display_priority: 6, type: 'mainright' },
  { module_id: 12, module_name: 'Go To X:Y', isactive: true, module_parent_id: 18, node_path: '18.12', sub_module: null, default_module: null, display_priority: 7, type: 'mainright' },
  { module_id: 58, module_name: 'Information Tool', isactive: true, module_parent_id: 18, node_path: '18.58', sub_module: null, default_module: true, display_priority: 8, type: 'mainright' },
  { module_id: 57, module_name: 'Selection Tool', isactive: true, module_parent_id: 18, node_path: '18.57', sub_module: null, default_module: true, display_priority: 9, type: 'mainright' },
  { module_id: 17, module_name: 'Basemap', isactive: true, module_parent_id: 18, node_path: '18.17', sub_module: null, default_module: true, display_priority: 10, type: 'mainright' },
  { module_id: 30, module_name: 'Free Search', isactive: true, module_parent_id: 18, node_path: '18.30', sub_module: null, default_module: true, display_priority: 11, type: 'mainright' },
  { module_id: 960, module_name: 'Workspace Details', isactive: true, module_parent_id: null, node_path: '960', sub_module: null, default_module: false, display_priority: 13, type: 'mainleft' },
  { module_id: 5, module_name: 'Advanced Tools', isactive: true, module_parent_id: null, node_path: '5', sub_module: null, default_module: null, display_priority: 20, type: 'mainleft' },
  { module_id: 1004, module_name: 'Service Area', isactive: true, module_parent_id: 5, node_path: '5.1004', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 13, module_name: 'Network Tracing', isactive: true, module_parent_id: 5, node_path: '5.13', sub_module: null, default_module: null, display_priority: 1, type: 'mainleft' },
  { module_id: 7, module_name: 'Routing', isactive: true, module_parent_id: 5, node_path: '5.7', sub_module: null, default_module: null, display_priority: 2, type: 'mainleft' },
  { module_id: 8, module_name: 'Basic Routing', isactive: true, module_parent_id: 7, node_path: '5.7.8', sub_module: null, default_module: null, display_priority: 1, type: 'mainleft' },
  { module_id: 10, module_name: 'Nearest Facility', isactive: true, module_parent_id: 7, node_path: '5.7.10', sub_module: null, default_module: null, display_priority: 2, type: 'mainleft' },
  { module_id: 69, module_name: 'Raster Analysis', isactive: true, module_parent_id: null, node_path: '69', sub_module: null, default_module: null, display_priority: 21, type: 'mainleft' },
  { module_id: 910, module_name: 'Raster Data', isactive: true, module_parent_id: 69, node_path: '69.910', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 911, module_name: 'Raster Upload & Publish', isactive: true, module_parent_id: 910, node_path: '69.910.911', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 912, module_name: 'Raster Styling', isactive: true, module_parent_id: 910, node_path: '69.910.912', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 913, module_name: 'Pixel Identify', isactive: true, module_parent_id: 910, node_path: '69.910.913', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 914, module_name: 'Raster Statistics & Histogram', isactive: true, module_parent_id: 910, node_path: '69.910.914', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 915, module_name: 'Mosaic / Merge', isactive: true, module_parent_id: 910, node_path: '69.910.915', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 916, module_name: 'Resample / Reproject', isactive: true, module_parent_id: 910, node_path: '69.910.916', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 917, module_name: 'Rasterize Vector', isactive: true, module_parent_id: 910, node_path: '69.910.917', sub_module: null, default_module: false, display_priority: 7, type: 'mainleft' },
  { module_id: 918, module_name: 'Download Raster', isactive: true, module_parent_id: 910, node_path: '69.910.918', sub_module: null, default_module: false, display_priority: 8, type: 'mainleft' },
  { module_id: 919, module_name: 'Download from Online Sources', isactive: true, module_parent_id: 910, node_path: '69.910.919', sub_module: null, default_module: false, display_priority: 9, type: 'mainleft' },
  { module_id: 920, module_name: 'Terrain Analysis', isactive: true, module_parent_id: 69, node_path: '69.920', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 921, module_name: 'Elevation Profile', isactive: true, module_parent_id: 920, node_path: '69.920.921', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 922, module_name: 'Slope', isactive: true, module_parent_id: 920, node_path: '69.920.922', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 923, module_name: 'Aspect', isactive: true, module_parent_id: 920, node_path: '69.920.923', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 924, module_name: 'Hillshade', isactive: true, module_parent_id: 920, node_path: '69.920.924', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 925, module_name: 'Contour Generation', isactive: true, module_parent_id: 920, node_path: '69.920.925', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 926, module_name: 'Cut & Fill / Volume', isactive: true, module_parent_id: 920, node_path: '69.920.926', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 927, module_name: 'Drainage / Watershed', isactive: true, module_parent_id: 920, node_path: '69.920.927', sub_module: null, default_module: false, display_priority: 7, type: 'mainleft' },
  { module_id: 928, module_name: 'Flood Inundation', isactive: true, module_parent_id: 920, node_path: '69.920.928', sub_module: null, default_module: false, display_priority: 8, type: 'mainleft' },
  { module_id: 929, module_name: 'Line of Sight', isactive: true, module_parent_id: 920, node_path: '69.920.929', sub_module: null, default_module: false, display_priority: 9, type: 'mainleft' },
  { module_id: 930, module_name: 'Viewshed', isactive: true, module_parent_id: 920, node_path: '69.920.930', sub_module: null, default_module: false, display_priority: 10, type: 'mainleft' },
  { module_id: 931, module_name: 'Terrain Ruggedness', isactive: true, module_parent_id: 920, node_path: '69.920.931', sub_module: null, default_module: false, display_priority: 11, type: 'mainleft' },
  { module_id: 932, module_name: 'Fill Sinks', isactive: true, module_parent_id: 920, node_path: '69.920.932', sub_module: null, default_module: false, display_priority: 12, type: 'mainleft' },
  { module_id: 933, module_name: 'Stream Network', isactive: true, module_parent_id: 920, node_path: '69.920.933', sub_module: null, default_module: false, display_priority: 13, type: 'mainleft' },
  { module_id: 934, module_name: '3D Terrain View', isactive: true, module_parent_id: 920, node_path: '69.920.934', sub_module: null, default_module: false, display_priority: 14, type: 'mainleft' },
  { module_id: 940, module_name: 'Raster Analytics', isactive: true, module_parent_id: 69, node_path: '69.940', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 942, module_name: 'Raster Calculator', isactive: true, module_parent_id: 940, node_path: '69.940.942', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 943, module_name: 'Reclassify', isactive: true, module_parent_id: 940, node_path: '69.940.943', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 944, module_name: 'Clip to Boundary', isactive: true, module_parent_id: 940, node_path: '69.940.944', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 945, module_name: 'Raster to Vector', isactive: true, module_parent_id: 940, node_path: '69.940.945', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 946, module_name: 'Zonal Statistics', isactive: true, module_parent_id: 940, node_path: '69.940.946', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 947, module_name: 'IDW Interpolation', isactive: true, module_parent_id: 940, node_path: '69.940.947', sub_module: null, default_module: false, display_priority: 7, type: 'mainleft' },
  { module_id: 948, module_name: 'Heatmap (Kernel Density)', isactive: true, module_parent_id: 940, node_path: '69.940.948', sub_module: null, default_module: false, display_priority: 8, type: 'mainleft' },
  { module_id: 949, module_name: 'Proximity / Distance', isactive: true, module_parent_id: 940, node_path: '69.940.949', sub_module: null, default_module: false, display_priority: 9, type: 'mainleft' },
  { module_id: 950, module_name: 'Imagery Analysis', isactive: true, module_parent_id: 69, node_path: '69.950', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 951, module_name: 'Swipe / Compare', isactive: true, module_parent_id: 950, node_path: '69.950.951', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 952, module_name: 'NDVI / Vegetation Index', isactive: true, module_parent_id: 950, node_path: '69.950.952', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 953, module_name: 'Change Detection', isactive: true, module_parent_id: 950, node_path: '69.950.953', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 954, module_name: 'Spectral Indices (NDWI / NDBI / SAVI)', isactive: true, module_parent_id: 950, node_path: '69.950.954', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 955, module_name: 'Unsupervised Classification', isactive: true, module_parent_id: 950, node_path: '69.950.955', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 956, module_name: 'Index Time Series', isactive: true, module_parent_id: 950, node_path: '69.950.956', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 957, module_name: 'Urban Heat Island (LST)', isactive: true, module_parent_id: 950, node_path: '69.950.957', sub_module: null, default_module: false, display_priority: 7, type: 'mainleft' },
  { module_id: 958, module_name: 'Supervised Classification', isactive: true, module_parent_id: 950, node_path: '69.950.958', sub_module: null, default_module: false, display_priority: 8, type: 'mainleft' },
  { module_id: 959, module_name: 'Land-cover Change Matrix', isactive: true, module_parent_id: 950, node_path: '69.950.959', sub_module: null, default_module: false, display_priority: 9, type: 'mainleft' },
  { module_id: 970, module_name: 'Decision Support', isactive: true, module_parent_id: 69, node_path: '69.970', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 971, module_name: 'Site Suitability (Weighted Overlay)', isactive: true, module_parent_id: 970, node_path: '69.970.971', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 972, module_name: 'Encroachment Monitor', isactive: true, module_parent_id: 970, node_path: '69.970.972', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 973, module_name: 'Green Cover Report', isactive: true, module_parent_id: 970, node_path: '69.970.973', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 974, module_name: 'Automatic Monitoring', isactive: true, module_parent_id: 970, node_path: '69.970.974', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 975, module_name: 'Flood Risk (HAND)', isactive: true, module_parent_id: 970, node_path: '69.970.975', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 976, module_name: 'Population Exposure', isactive: true, module_parent_id: 970, node_path: '69.970.976', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 977, module_name: 'Area Report', isactive: true, module_parent_id: 970, node_path: '69.970.977', sub_module: null, default_module: false, display_priority: 7, type: 'mainleft' },
  { module_id: 980, module_name: 'Extract Values to Points', isactive: true, module_parent_id: 940, node_path: '69.940.980', sub_module: null, default_module: false, display_priority: 10, type: 'mainleft' },
  { module_id: 981, module_name: 'Least-cost Path', isactive: true, module_parent_id: 940, node_path: '69.940.981', sub_module: null, default_module: false, display_priority: 11, type: 'mainleft' },
  { module_id: 982, module_name: 'Hotspot Analysis (Gi*)', isactive: true, module_parent_id: 940, node_path: '69.940.982', sub_module: null, default_module: false, display_priority: 12, type: 'mainleft' },
  { module_id: 983, module_name: 'Air Quality (NO₂)', isactive: true, module_parent_id: 950, node_path: '69.950.983', sub_module: null, default_module: false, display_priority: 10, type: 'mainleft' },
  { module_id: 984, module_name: 'Water Body Monitor', isactive: true, module_parent_id: 950, node_path: '69.950.984', sub_module: null, default_module: false, display_priority: 11, type: 'mainleft' },
  { module_id: 985, module_name: 'Curvature', isactive: true, module_parent_id: 920, node_path: '69.920.985', sub_module: null, default_module: false, display_priority: 15, type: 'mainleft' },
  { module_id: 986, module_name: 'Fill NoData / Smooth', isactive: true, module_parent_id: 910, node_path: '69.910.986', sub_module: null, default_module: false, display_priority: 10, type: 'mainleft' },
  { module_id: 987, module_name: 'Object Heights (DSM − DTM)', isactive: true, module_parent_id: 920, node_path: '69.920.987', sub_module: null, default_module: false, display_priority: 16, type: 'mainleft' },
  { module_id: 990, module_name: 'Workspace', isactive: true, module_parent_id: 69, node_path: '69.990', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 991, module_name: 'Saved Workflows', isactive: true, module_parent_id: 990, node_path: '69.990.991', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 992, module_name: 'Job History', isactive: true, module_parent_id: 990, node_path: '69.990.992', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 993, module_name: 'Time Slider', isactive: true, module_parent_id: 990, node_path: '69.990.993', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 994, module_name: 'Storage Manager', isactive: true, module_parent_id: 990, node_path: '69.990.994', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 995, module_name: 'Share Result', isactive: true, module_parent_id: 990, node_path: '69.990.995', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 996, module_name: 'Dashboard Pins', isactive: true, module_parent_id: 990, node_path: '69.990.996', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 14, module_name: 'Dashboard', isactive: true, module_parent_id: null, node_path: '14', sub_module: null, default_module: null, display_priority: 22, type: 'mainleft' },
  { module_id: 55, module_name: 'Edit Panel', isactive: true, module_parent_id: null, node_path: '55', sub_module: null, default_module: null, display_priority: 23, type: 'mainleft' },
  { module_id: 1001, module_name: 'Edit History', isactive: true, module_parent_id: 55, node_path: '55.1001', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 1005, module_name: 'Attachments', isactive: true, module_parent_id: 55, node_path: '55.1005', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 1006, module_name: 'Parcel Tools (Split / Merge / COGO)', isactive: true, module_parent_id: 55, node_path: '55.1006', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 1007, module_name: 'Field Collection (Mobile)', isactive: true, module_parent_id: 55, node_path: '55.1007', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 1010, module_name: 'Data Tools', isactive: true, module_parent_id: null, node_path: '1010', sub_module: null, default_module: false, display_priority: 23, type: 'mainleft' },
  { module_id: 1011, module_name: 'Field Calculator', isactive: true, module_parent_id: 1010, node_path: '1010.1011', sub_module: null, default_module: false, display_priority: 1, type: 'mainleft' },
  { module_id: 1012, module_name: 'Table Join', isactive: true, module_parent_id: 1010, node_path: '1010.1012', sub_module: null, default_module: false, display_priority: 2, type: 'mainleft' },
  { module_id: 1013, module_name: 'Geocode Addresses', isactive: true, module_parent_id: 1010, node_path: '1010.1013', sub_module: null, default_module: false, display_priority: 3, type: 'mainleft' },
  { module_id: 1014, module_name: 'Topology Validation', isactive: true, module_parent_id: 1010, node_path: '1010.1014', sub_module: null, default_module: false, display_priority: 4, type: 'mainleft' },
  { module_id: 1015, module_name: 'Field Rules', isactive: true, module_parent_id: 1010, node_path: '1010.1015', sub_module: null, default_module: false, display_priority: 5, type: 'mainleft' },
  { module_id: 1016, module_name: 'Versions & Change Detection', isactive: true, module_parent_id: 1010, node_path: '1010.1016', sub_module: null, default_module: false, display_priority: 6, type: 'mainleft' },
  { module_id: 1002, module_name: 'Geoprocessing', isactive: true, module_parent_id: null, node_path: '1002', sub_module: null, default_module: false, display_priority: 23, type: 'mainleft' },
  { module_id: 67, module_name: 'Time Series', isactive: true, module_parent_id: null, node_path: '67', sub_module: null, default_module: null, display_priority: 24, type: 'mainleft' },
  { module_id: 74, module_name: '3D Button', isactive: true, module_parent_id: null, node_path: '74', sub_module: null, default_module: null, display_priority: 25, type: 'mainleft' },
  { module_id: 221, module_name: 'Lidar View', isactive: true, module_parent_id: null, node_path: '221', sub_module: null, default_module: null, display_priority: 26, type: 'mainleft' },
  { module_id: 185, module_name: 'Activity Log', isactive: true, module_parent_id: null, node_path: '185', sub_module: null, default_module: null, display_priority: 27, type: 'mainleft' },
];

async function main() {
  console.log(`Seeding ${MODULES.length} modules...`);
  for (const m of MODULES) {
    await prisma.module.upsert({
      where: { id: m.module_id },
      create: {
        id: m.module_id,
        name: m.module_name,
        isActive: m.isactive,
        parentId: m.module_parent_id,
        nodePath: m.node_path,
        subModule: m.sub_module,
        defaultModule: m.default_module,
        displayPriority: m.display_priority,
        type: m.type
      },
      update: {
        name: m.module_name,
        isActive: m.isactive,
        parentId: m.module_parent_id,
        nodePath: m.node_path,
        subModule: m.sub_module,
        defaultModule: m.default_module,
        displayPriority: m.display_priority,
        type: m.type
      }
    });
  }
  console.log('Done.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
