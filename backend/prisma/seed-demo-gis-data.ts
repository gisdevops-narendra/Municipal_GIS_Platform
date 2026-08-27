/**
 * One-time, idempotent dev script: seeds hand-authored DEMO geometry for
 * the boundary/wards/roads layers of ONE municipality, so there's actually
 * something to see on the map during local development. Not real
 * municipal GIS data, not run automatically, not part of the migration —
 * see docs/backend.md "GIS Layers" / Task 6 §31.
 *
 * The GISLayer *metadata* rows (and their published GeoServer feature
 * types) already exist for every municipality via
 * GisWorkspaceService.provisionWorkspace ->
 * GisLayersService.ensureDemoLayers, which runs automatically at
 * registration. This script only inserts feature ROWS into the shared
 * gis_demo_* tables, tagged with one municipality's gis_workspace_id.
 *
 * Usage: `npm run seed:gis-demo` (from backend/), or target a different
 * municipality by official email: `npm run seed:gis-demo -- owner@x.gov.in`
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_OFFICIAL_EMAIL = 'owner@somnath.gov.in';

// A small, self-contained demo area under EPSG:32643 (the workspace's
// default storage CRS) — not tied to any municipality's real coordinates.
// 3km (E-W) x 2.4km (N-S), split into a 2x2 ward grid with a simple road
// grid running through it.
const BOUNDARY_WKT = 'POLYGON((505500 2300300, 508500 2300300, 508500 2302700, 505500 2302700, 505500 2300300))';

const WARDS = [
  { name: 'Ward 1 (Demo)', number: 1, wkt: 'POLYGON((505500 2301500, 507000 2301500, 507000 2302700, 505500 2302700, 505500 2301500))' },
  { name: 'Ward 2 (Demo)', number: 2, wkt: 'POLYGON((507000 2301500, 508500 2301500, 508500 2302700, 507000 2302700, 507000 2301500))' },
  { name: 'Ward 3 (Demo)', number: 3, wkt: 'POLYGON((505500 2300300, 507000 2300300, 507000 2301500, 505500 2301500, 505500 2300300))' },
  { name: 'Ward 4 (Demo)', number: 4, wkt: 'POLYGON((507000 2300300, 508500 2300300, 508500 2301500, 507000 2301500, 507000 2300300))' }
];

const ROADS = [
  { name: 'MG Road (Demo)', type: 'Municipal Road', wkt: 'LINESTRING(505500 2301500, 508500 2301500)' },
  { name: 'Station Road (Demo)', type: 'Municipal Road', wkt: 'LINESTRING(507000 2300300, 507000 2302700)' },
  { name: 'Ring Road North (Demo)', type: 'Ring Road', wkt: 'LINESTRING(505500 2302700, 508500 2302700)' },
  { name: 'Ring Road South (Demo)', type: 'Ring Road', wkt: 'LINESTRING(505500 2300300, 508500 2300300)' },
  { name: 'East Avenue (Demo)', type: 'Collector Road', wkt: 'LINESTRING(508500 2300300, 508500 2302700)' },
  { name: 'West Avenue (Demo)', type: 'Collector Road', wkt: 'LINESTRING(505500 2300300, 505500 2302700)' }
];

async function main(): Promise<void> {
  const officialEmail = process.argv[2] ?? DEFAULT_OFFICIAL_EMAIL;

  const municipality = await prisma.municipality.findUnique({ where: { officialEmail } });
  if (!municipality) {
    console.log(`No municipality found with official email "${officialEmail}". Register it first — see docs/backend.md.`);
    return;
  }

  const workspace = await prisma.gISWorkspace.findUnique({ where: { municipalityId: municipality.id } });
  if (!workspace) {
    console.log(`"${municipality.name}" has no GIS workspace yet. Call GET /api/gis/workspace once to provision it, then re-run this script.`);
    return;
  }

  const existing = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::bigint AS count FROM gis_demo_wards WHERE gis_workspace_id = ${workspace.id}
  `;
  if (existing[0].count > 0n) {
    console.log(`Demo GIS data already seeded for "${municipality.name}" (workspace "${workspace.geoserverWorkspace}") — skipping.`);
    return;
  }

  console.log(`Seeding Task 6 DEMO GIS data for "${municipality.name}" (workspace "${workspace.geoserverWorkspace}")...`);

  await prisma.$executeRaw`
    INSERT INTO gis_demo_municipal_boundary (gis_workspace_id, name, status, geom)
    VALUES (${workspace.id}, ${municipality.name + ' Boundary (Demo)'}, 'Active', ST_Multi(ST_GeomFromText(${BOUNDARY_WKT}, 32643)))
  `;

  for (const ward of WARDS) {
    await prisma.$executeRaw`
      INSERT INTO gis_demo_wards (gis_workspace_id, name, ward_number, geom)
      VALUES (${workspace.id}, ${ward.name}, ${ward.number}, ST_Multi(ST_GeomFromText(${ward.wkt}, 32643)))
    `;
  }

  for (const road of ROADS) {
    await prisma.$executeRaw`
      INSERT INTO gis_demo_roads (gis_workspace_id, name, road_type, status, geom)
      VALUES (${workspace.id}, ${road.name}, ${road.type}, 'Active', ST_Multi(ST_GeomFromText(${road.wkt}, 32643)))
    `;
  }

  console.log(`Seeded 1 boundary, ${WARDS.length} wards, ${ROADS.length} roads.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
