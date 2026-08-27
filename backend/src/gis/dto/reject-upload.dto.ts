import { IsString, MaxLength, MinLength } from 'class-validator';

export class RejectUploadDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  rejectionReason!: string;
}
