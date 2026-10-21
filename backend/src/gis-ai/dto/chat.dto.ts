import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsUUID,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChatTurnDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  @MaxLength(4000)
  content!: string;
}

export class GisChatDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  message!: string;

  /** Optional layer the user currently has in focus (a hint for the LLM). */
  @IsOptional()
  @IsString()
  activeLayerId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatTurnDto)
  history?: ChatTurnDto[];

  /** The operation the previous answer ran, so a follow-up ("now only
   *  those in ward 5") extends it. Re-validated like any plan. */
  @IsOptional()
  @IsObject()
  previousOperation?: Record<string, unknown>;

  /** A clicked option's plan ("Did you mean …", field choice): run as is,
   *  no model call — validated by the compiler like any plan. */
  @IsOptional()
  @IsObject()
  resolvedOperation?: Record<string, unknown>;

  /** Chat this question belongs to; omitted = start a new chat. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

/** `POST /gis/ai/narrate` — the question plus the `facts` a chat answer
 *  came back with. */
export class GisNarrateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  question!: string;

  @IsObject()
  facts!: Record<string, unknown>;
}

export class ExplainFactDto {
  @IsString()
  @MaxLength(120)
  label!: string;

  @IsString()
  @MaxLength(300)
  value!: string;
}

/** `POST /gis/ai/explain` — a finished Raster Analysis result as the panel
 *  shows it: its title, the label/value facts and, optionally, its table. */
export class GisExplainDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  title!: string;

  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ExplainFactDto)
  facts!: ExplainFactDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsObject({ each: true })
  rows?: Record<string, unknown>[];
}

/** `POST /gis/ai/feedback` — 👍/👎 on one of the caller's own answers. */
export class GisFeedbackDto {
  @IsUUID()
  logId!: string;

  @IsBoolean()
  helpful!: boolean;
}
