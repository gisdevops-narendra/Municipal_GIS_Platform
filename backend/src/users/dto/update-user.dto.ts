import {
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_PATTERN = /^[0-9+\-\s()]{7,20}$/;

/** Email is intentionally not editable here: it doubles as the Keycloak
 *  username, and changing it would desynchronize the two systems — out of
 *  scope for this task. */
export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName?: string;

  @IsOptional()
  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'mobileNumber must be a valid phone number',
  })
  mobileNumber?: string;

  /** Pass null to unassign the user from any department. */
  @IsOptional()
  @IsUUID()
  departmentId?: string | null;

  /** Task 8: lets the Owner promote/demote between the two managed roles.
   *  MUNICIPALITY_OWNER is never accepted here — ownership transfer is out
   *  of scope. */
  @IsOptional()
  @IsIn(['DEPARTMENT_HEAD', 'DEPARTMENT_USER'])
  role?: 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';
}

export class UpdateUserStatusDto {
  @IsIn(['ACTIVE', 'DISABLED'])
  status!: 'ACTIVE' | 'DISABLED';
}
