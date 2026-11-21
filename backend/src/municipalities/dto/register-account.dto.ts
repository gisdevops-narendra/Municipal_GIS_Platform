import {
  Equals,
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Self-service account sign-up. Each account gets its own private GIS
 * workspace behind the scenes (stored as a Municipality row — an internal
 * tenant only, never shown to the user). The account is always created
 * as that workspace's owner; no role is accepted from the client.
 */
export class RegisterAccountDto {
  @IsString()
  @MinLength(2)
  @MaxLength(150)
  fullName!: string;

  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[0-9+\-\s()]{7,20}$/, {
    message: 'mobileNumber must be a valid phone number',
  })
  mobileNumber?: string;

  /** Must be true: the user accepted the Terms of Service and Privacy
   *  Policy (version TERMS_VERSION) on the sign-up form. */
  @Equals(true, { message: 'You must accept the Terms of Service and Privacy Policy.' })
  acceptTerms!: boolean;

  /** Honeypot: a hidden form field people never see. Bots that fill in
   *  every field set it — such sign-ups are rejected. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;

  /** Forwarded once to Keycloak; never stored in our database. */
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}

/** Bump when the Terms of Service / Privacy Policy text changes. */
export const TERMS_VERSION = '2026-11-21';
