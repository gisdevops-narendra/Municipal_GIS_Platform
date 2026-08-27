import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_PATTERN = /^[0-9+\-\s()]{7,20}$/;

/**
 * Fields an Owner supplies to create a new municipality user. Deliberately
 * has no `municipalityId` field — the backend always assigns the actor's
 * own municipality, never accepted from the client. `role` accepts only
 * DEPARTMENT_HEAD/DEPARTMENT_USER (Task 8) — MUNICIPALITY_OWNER is never
 * accepted from the client, matching the pre-Task-8 rule of never letting
 * a caller assign the owner role to anyone. No `password` field either —
 * see KeycloakAdminService.createUserWithTemporaryPassword.
 */
export class CreateUserDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'mobileNumber must be a valid phone number',
  })
  mobileNumber!: string;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  /** Defaults to DEPARTMENT_USER when omitted (matches the pre-Task-8
   *  behavior of every owner-created user getting the more restricted
   *  role by default). */
  @IsOptional()
  @IsIn(['DEPARTMENT_HEAD', 'DEPARTMENT_USER'])
  role?: 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';
}
