import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const PHONE_PATTERN = /^[0-9+\-\s()]{7,20}$/;

/**
 * Self-service profile edit (`PATCH /api/me`). Only the two fields a user
 * may change about themselves. Email is the Keycloak username (changing it
 * would desync the two systems); role / department / status are
 * administrative and stay owner-only via `PATCH /api/users/:id`.
 */
export class UpdateMeDto {
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
}
