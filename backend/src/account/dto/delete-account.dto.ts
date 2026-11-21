import { IsString, MaxLength, MinLength } from 'class-validator';

/** `POST /api/me/delete` — the current password confirms the deletion. */
export class DeleteAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
