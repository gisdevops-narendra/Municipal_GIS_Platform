import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const PHONE_PATTERN = /^[0-9+\-\s()]{7,20}$/;

export class MunicipalityInfoDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  type!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  state!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  district!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city!: string;

  @IsEmail()
  @MaxLength(255)
  officialEmail!: string;

  @IsString()
  @Matches(PHONE_PATTERN, {
    message: 'contactNumber must be a valid phone number',
  })
  contactNumber!: string;
}

/**
 * Owner identity + credentials supplied at registration time. NOTE: `role`
 * is deliberately not a field here — the backend always assigns
 * MUNICIPALITY_OWNER for the first user of a new municipality; it is never
 * accepted from the client.
 */
export class OwnerInfoDto {
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

  /** Forwarded once to Keycloak to create the account's credentials. Never
   *  persisted in our own database — see KeycloakAdminService. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

export class RegisterMunicipalityDto {
  @ValidateNested()
  @Type(() => MunicipalityInfoDto)
  municipality!: MunicipalityInfoDto;

  @ValidateNested()
  @Type(() => OwnerInfoDto)
  owner!: OwnerInfoDto;
}
