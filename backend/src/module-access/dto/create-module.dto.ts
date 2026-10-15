import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Mirrors the `type` values already present in the seeded catalog (see
 *  prisma/seed-modules.ts) — grouping tags the admin UI and the /gis
 *  workspace rail key off of, not a hierarchy relationship. */
export const MODULE_TYPES = [
  'mainleft',
  'mainright',
  'bottomvertical',
  'bottomhorizontal',
  'other',
] as const;

/**
 * Body for POST /api/module-access/catalog — a Municipality Owner adding
 * one new module to the global catalog (ModuleAccessService.createModule).
 * `id`/`nodePath` are never supplied by the caller: the id comes from the
 * `modules_module_id_seq` sequence and the nodePath is derived from
 * `parentId` server-side.
 */
export class CreateModuleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  name!: string;

  /** An existing active module this one nests under. Omitted = top-level. */
  @IsOptional()
  @IsInt()
  parentId?: number;

  @IsOptional()
  @IsIn(MODULE_TYPES)
  type?: (typeof MODULE_TYPES)[number];

  /** Always-on for every user regardless of any grant — see the Module
   *  schema doc. Defaults to false: a newly added module starts governed
   *  by the normal grant hierarchy. */
  @IsOptional()
  @IsBoolean()
  defaultModule?: boolean;

  @IsOptional()
  @IsInt()
  displayPriority?: number;
}
