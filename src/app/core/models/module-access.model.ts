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
