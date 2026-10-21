import { IsBoolean } from 'class-validator';

export class UpdateOnboardingDto {
  @IsBoolean()
  dismissed!: boolean;
}
