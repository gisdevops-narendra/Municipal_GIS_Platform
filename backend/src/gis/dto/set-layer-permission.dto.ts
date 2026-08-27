import { IsBoolean, IsIn, IsUUID } from 'class-validator';

/**
 * Body for PUT /api/gis/layers/:id/permissions — one checkbox toggle at a
 * time (Task 8 §7). `role` deliberately excludes MUNICIPALITY_OWNER — the
 * Owner's access is unconditional and never stored as a grant row (see
 * GisAuthorizationService).
 */
export class SetLayerPermissionDto {
  @IsUUID()
  departmentId!: string;

  @IsIn(['DEPARTMENT_HEAD', 'DEPARTMENT_USER'])
  role!: 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';

  @IsIn(['VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE'])
  permission!: 'VIEW' | 'UPLOAD' | 'APPROVE' | 'PUBLISH' | 'EXPORT' | 'MANAGE';

  @IsBoolean()
  granted!: boolean;
}
