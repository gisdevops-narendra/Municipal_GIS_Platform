import { ArrayUnique, IsArray, IsInt } from 'class-validator';

/**
 * Body for PUT /api/module-access/departments/:departmentId and
 * PUT /api/module-access/users/:userId — a full replace of that target's
 * explicit module grants (never a single add/remove), matching how the
 * tree-checklist admin UI edits it: check/uncheck, save the whole set.
 */
export class SetModuleGrantsDto {
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  moduleIds!: number[];
}
