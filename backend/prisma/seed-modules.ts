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
  { module_id: 227, module_name: 'Export to csv', isactive: true, module_parent_id: 226, node_path: '226.227', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 229, module_name: 'Data Visualisation', isactive: true, module_parent_id: null, node_path: '229', sub_module: null, default_module: null, display_priority: 36, type: 'mainleft' },
  { module_id: 69, module_name: 'Raster Analysis', isactive: true, module_parent_id: null, node_path: '69', sub_module: null, default_module: null, display_priority: 5, type: 'mainleft' },
  { module_id: 221, module_name: 'Lidar View', isactive: true, module_parent_id: null, node_path: '221', sub_module: null, default_module: null, display_priority: 31, type: 'mainleft' },
  { module_id: 219, module_name: 'RASTER ANALST', isactive: true, module_parent_id: null, node_path: '219', sub_module: null, default_module: null, display_priority: 30, type: 'mainleft' },
  { module_id: 32, module_name: 'Draw', isactive: true, module_parent_id: null, node_path: '32', sub_module: null, default_module: null, display_priority: 20, type: 'mainleft' },
  { module_id: 185, module_name: 'Activity Log', isactive: true, module_parent_id: null, node_path: '185', sub_module: null, default_module: null, display_priority: 23, type: 'mainleft' },
  { module_id: 186, module_name: 'Analytics', isactive: true, module_parent_id: null, node_path: '186', sub_module: null, default_module: null, display_priority: 24, type: 'mainleft' },
  { module_id: 222, module_name: 'Digital Twin', isactive: true, module_parent_id: null, node_path: '222', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 55, module_name: 'Edit Panel', isactive: true, module_parent_id: null, node_path: '55', sub_module: null, default_module: null, display_priority: 3, type: 'mainleft' },
  { module_id: 226, module_name: 'Export Data', isactive: true, module_parent_id: null, node_path: '226', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 50, module_name: 'Attribute Query', isactive: true, module_parent_id: 2, node_path: '2.50', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 71, module_name: 'Line of Sight', isactive: true, module_parent_id: 70, node_path: '5.70.71', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 68, module_name: 'Terrain Analysis', isactive: true, module_parent_id: 5, node_path: '5.68', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 72, module_name: 'Viewshed', isactive: true, module_parent_id: 70, node_path: '5.70.72', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 187, module_name: 'MultiBuffer', isactive: true, module_parent_id: 5, node_path: '5.187', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 228, module_name: 'Export to shapefile', isactive: true, module_parent_id: 226, node_path: '226.228', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 51, module_name: 'Elevation Profile', isactive: true, module_parent_id: 5, node_path: '5.51', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 224, module_name: 'is_configured', isactive: true, module_parent_id: 9, node_path: null, sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 220, module_name: 'DEM ANALYST', isactive: true, module_parent_id: 219, node_path: '219.220', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 230, module_name: 'Export to kml', isactive: true, module_parent_id: 226, node_path: '226.230', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 21, module_name: 'Pan', isactive: true, module_parent_id: 18, node_path: '18.21', sub_module: null, default_module: true, display_priority: 4, type: 'bottomhorizontal' },
  { module_id: 59, module_name: 'Nav History', isactive: true, module_parent_id: 18, node_path: '18.59', sub_module: null, default_module: null, display_priority: 3, type: 'bottomhorizontal' },
  { module_id: 19, module_name: 'Zoom In', isactive: true, module_parent_id: 18, node_path: '18.19', sub_module: null, default_module: true, display_priority: 6, type: 'bottomhorizontal' },
  { module_id: 20, module_name: 'Zoom Out', isactive: true, module_parent_id: 18, node_path: '18.20', sub_module: null, default_module: true, display_priority: 5, type: 'bottomhorizontal' },
  { module_id: 253, module_name: 'Module Create', isactive: true, module_parent_id: 245, node_path: '245.253', sub_module: null, default_module: null, display_priority: null, type: null },
  { module_id: 74, module_name: '3D Button', isactive: true, module_parent_id: null, node_path: '74', sub_module: null, default_module: null, display_priority: 22, type: 'mainleft' },
  { module_id: 5, module_name: 'Advanced Tools', isactive: true, module_parent_id: null, node_path: '5', sub_module: null, default_module: null, display_priority: 4, type: 'mainleft' },
  { module_id: 11, module_name: 'Measure', isactive: true, module_parent_id: 5, node_path: '5.11', sub_module: null, default_module: true, display_priority: 1, type: 'bottomvertical' },
  { module_id: 58, module_name: 'Information Tool', isactive: true, module_parent_id: 18, node_path: '18.58', sub_module: null, default_module: true, display_priority: 2, type: 'bottomhorizontal' },
  { module_id: 70, module_name: '3D Analyst', isactive: true, module_parent_id: 5, node_path: '5.70', sub_module: null, default_module: null, display_priority: 1, type: 'bottomhorizontal' },
  { module_id: 17, module_name: 'Basemap', isactive: true, module_parent_id: null, node_path: '17', sub_module: null, default_module: true, display_priority: 3, type: 'bottomvertical' },
  { module_id: 57, module_name: 'Selection Tool', isactive: true, module_parent_id: 18, node_path: '18.57', sub_module: null, default_module: true, display_priority: 2, type: 'bottomvertical' },
  { module_id: 1, module_name: 'Layer Switcher', isactive: true, module_parent_id: null, node_path: '1', sub_module: null, default_module: true, display_priority: 1, type: 'mainleft' },
  { module_id: 2, module_name: 'Query Module', isactive: true, module_parent_id: null, node_path: '2', sub_module: null, default_module: null, display_priority: 2, type: 'mainleft' },
  { module_id: 3, module_name: 'Print', isactive: true, module_parent_id: null, node_path: '3', sub_module: null, default_module: true, display_priority: 35, type: 'mainright' },
  { module_id: 4, module_name: 'Bookmark', isactive: true, module_parent_id: null, node_path: '4', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 27, module_name: 'Complaint redressal', isactive: true, module_parent_id: null, node_path: '27', sub_module: null, default_module: null, display_priority: 15, type: 'other' },
  { module_id: 6, module_name: 'Buffer', isactive: true, module_parent_id: 2, node_path: '2.6', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 7, module_name: 'Routing', isactive: true, module_parent_id: 5, node_path: '5.7', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 8, module_name: 'Basic Routing', isactive: true, module_parent_id: 7, node_path: '5.7.8', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 10, module_name: 'Nearest Facility', isactive: true, module_parent_id: 7, node_path: '5.7.10', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 12, module_name: 'Go To X:Y', isactive: true, module_parent_id: 5, node_path: '5.12', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 14, module_name: 'Dashboard', isactive: true, module_parent_id: null, node_path: '14', sub_module: null, default_module: null, display_priority: 6, type: 'mainleft' },
  { module_id: 15, module_name: 'Attribute Table', isactive: true, module_parent_id: null, node_path: '15', sub_module: null, default_module: true, display_priority: 3, type: 'mainleft' },
  { module_id: 16, module_name: 'Spatial Query', isactive: true, module_parent_id: 2, node_path: '2.16', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 18, module_name: 'Basic Tools', isactive: true, module_parent_id: null, node_path: '18', sub_module: null, default_module: true, display_priority: null, type: 'bottomvertical' },
  { module_id: 22, module_name: 'PDM', isactive: true, module_parent_id: null, node_path: '22', sub_module: null, default_module: null, display_priority: 7, type: 'mainleft' },
  { module_id: 23, module_name: 'Know your property', isactive: true, module_parent_id: null, node_path: '23', sub_module: null, default_module: null, display_priority: 11, type: 'other' },
  { module_id: 24, module_name: 'Know your ward', isactive: true, module_parent_id: null, node_path: '24', sub_module: null, default_module: null, display_priority: 12, type: 'other' },
  { module_id: 26, module_name: 'Events', isactive: true, module_parent_id: null, node_path: '26', sub_module: null, default_module: null, display_priority: 14, type: 'other' },
  { module_id: 28, module_name: 'Crowd-source', isactive: true, module_parent_id: null, node_path: '28', sub_module: null, default_module: null, display_priority: 16, type: 'other' },
  { module_id: 29, module_name: 'Social media', isactive: true, module_parent_id: null, node_path: '29', sub_module: null, default_module: null, display_priority: 17, type: 'other' },
  { module_id: 30, module_name: 'Free Search', isactive: true, module_parent_id: null, node_path: '30', sub_module: null, default_module: true, display_priority: null, type: 'mainright' },
  { module_id: 31, module_name: 'Layer Switcher CP', isactive: true, module_parent_id: null, node_path: '31', sub_module: null, default_module: null, display_priority: 19, type: 'other' },
  { module_id: 33, module_name: 'Announcments', isactive: true, module_parent_id: 0, node_path: '33', sub_module: null, default_module: null, display_priority: null, type: 'other' },
  { module_id: 66, module_name: 'SWM', isactive: true, module_parent_id: null, node_path: '66', sub_module: null, default_module: null, display_priority: 21, type: 'other' },
  { module_id: 25, module_name: 'Heritage', isactive: true, module_parent_id: null, node_path: null, sub_module: null, default_module: null, display_priority: 13, type: 'other' },
  { module_id: 251, module_name: 'Report Generation', isactive: true, module_parent_id: null, node_path: '251', sub_module: null, default_module: null, display_priority: 37, type: 'mainleft' },
  { module_id: 13, module_name: 'Network Tracing', isactive: true, module_parent_id: 5, node_path: '5.13', sub_module: null, default_module: null, display_priority: null, type: 'mainleft' },
  { module_id: 252, module_name: 'VTS', isactive: true, module_parent_id: null, node_path: '252', sub_module: null, default_module: true, display_priority: 37, type: 'mainleft' },
  { module_id: 73, module_name: 'Marking Tool', isactive: true, module_parent_id: null, node_path: '73', sub_module: null, default_module: null, display_priority: 9, type: 'mainleft' },
  { module_id: 254, module_name: 'module_create_', isactive: true, module_parent_id: 26, node_path: '26.254', sub_module: null, default_module: null, display_priority: null, type: null },
  { module_id: 255, module_name: 'New Module', isactive: true, module_parent_id: 5, node_path: '5.255', sub_module: null, default_module: null, display_priority: null, type: null },
  { module_id: 67, module_name: 'Time Series', isactive: true, module_parent_id: null, node_path: '67', sub_module: null, default_module: null, display_priority: 8, type: 'mainleft' }
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
