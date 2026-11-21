import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /api/me/email` — new sign-in email, confirmed by the password. */
export class ChangeEmailDto {
  @IsEmail()
  @MaxLength(255)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
