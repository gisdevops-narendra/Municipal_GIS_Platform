/** One row of the global Module Access catalog (GET /api/module-access/catalog).
 *  Shared across every municipality — not tenant-scoped. `nodePath` is the
 *  authoritative hierarchy source (dot-separated ancestor chain, e.g.
 *  "226.227"); see the backend's Module schema doc for why it's preferred
 *  over `parentId`. */
export interface ModuleCatalogEntry {
  id: number;
  name: string;
  parentId: number | null;
  nodePath: string | null;
  defaultModule: boolean | null;
  displayPriority: number | null;
  type: string | null;
}

export interface DepartmentModuleGrants {
  departmentId: string;
  /** Exactly what was explicitly granted — what the checkboxes reflect. */
  explicitModuleIds: number[];
  /** explicitModuleIds expanded with ancestors + every default module —
   *  what the department (and its Head) actually has access to. */
  effectiveModuleIds: number[];
}

export interface UserModuleGrants {
  userId: string;
  explicitModuleIds: number[];
  effectiveModuleIds: number[];
  /** The user's own department's effective set — the ceiling a
   *  Department Head may grant from; a Department User's grants are
   *  always a subset of this, enforced server-side. */
  departmentEffectiveModuleIds: number[];
}

/** The grouping tags already present in the seeded catalog (see
 *  backend/prisma/seed-modules.ts) — offered as the `type` choices in the
 *  "Add Module" form. Purely a display/grouping tag, not a hierarchy
 *  relationship (that's nodePath/parentId). */
export const MODULE_TYPES = [
  'mainleft',
  'mainright',
  'bottomvertical',
  'bottomhorizontal',
  'other'
] as const;
export type ModuleType = (typeof MODULE_TYPES)[number];

/** Body for POST /api/module-access/catalog — Owner-only. `id`/`nodePath`
 *  are never supplied by the caller; the backend derives nodePath from
 *  `parentId`. */
export interface CreateModuleRequest {
  name: string;
  parentId?: number;
  type?: ModuleType;
  defaultModule?: boolean;
  displayPriority?: number;
}

/** Catalog modules that have a working tool in the app today (gated tools
 *  plus the always-on map basics: zoom, pan, basemap, identify). Shown as
 *  "Developed" in the Module Access list; keep in sync as tools ship. */
export const DEVELOPED_MODULE_IDS: ReadonlySet<number> = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21, 30, 32, 50, 57, 58, 59, 69, 73,
  186, 187, 226, 227, 228, 229, 230, 231, 251, 900, 901, 910, 911, 912, 913, 914, 915, 916, 917, 918, 919, 920, 921, 922, 923, 924, 925,
  926, 927, 928, 929, 930, 931, 932, 933, 934, 940, 942, 943, 944, 945, 946, 947, 948, 949, 950, 951, 952, 953, 954, 955, 956, 957, 958, 959, 960, 961, 962, 963, 970, 971, 972, 973, 974, 975, 976, 977, 980, 981, 982, 983, 984, 985, 986, 987, 990, 991, 992, 993, 994, 995, 996,
  1001, 1002, 1005, 1006, 1007, 1010, 1011, 1012, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028,
  1031, 1032, 1033, 1034, 1035
]);

export type ModuleDevStatus = 'developed' | 'partial' | 'not-developed';

/** Catalog ids of GIS workspace features gated since migration
 *  20261016090000 (also in prisma/seed-modules.ts). */
export const AI_ASSISTANT_MODULE_ID = 900;
export const LAYER_STYLING_MODULE_ID = 901;
export const PAN_MODULE_ID = 21;
export const BASEMAP_MODULE_ID = 17;
export const INFORMATION_TOOL_MODULE_ID = 58;
export const FREE_SEARCH_MODULE_ID = 30;
export const WORKSPACE_DETAILS_MODULE_ID = 960;
