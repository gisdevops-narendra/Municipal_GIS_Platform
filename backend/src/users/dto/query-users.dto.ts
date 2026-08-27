import { IsIn, IsOptional, IsString, IsUUID } from 'class-validator';

export class QueryUsersDto {
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  /** Free-text match against name/email, applied server-side. */
  @IsOptional()
  @IsString()
  search?: string;
}
