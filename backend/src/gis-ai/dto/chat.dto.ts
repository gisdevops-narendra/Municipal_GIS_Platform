import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsUUID,
  IsIn,
  Max,
  Min,
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

export class AnswerFormatDto {
  /** BCP-47 locale for digit grouping (en-IN = 1,00,000). */
  @IsOptional()
  @IsString()
  @MaxLength(20)
  numberLocale?: string;

  @IsOptional()
  @IsIn(['auto', 'm', 'km'])
  distanceUnit?: 'auto' | 'm' | 'km';

  @IsOptional()
  @IsIn(['auto', 'sqm', 'ha', 'acre'])
  areaUnit?: 'auto' | 'sqm' | 'ha' | 'acre';
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

  // ---- assistant settings (see AssistantSettings in the frontend) ----

  /** Only these layers may be used; omitted = every layer the user sees. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  layerIds?: string[];

  /** "Only the current map view": [minX, minY, maxX, maxY], EPSG:4326. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(4)
  @ArrayMaxSize(4)
  @IsNumber({}, { each: true })
  viewBbox?: number[];

  /** Never call the language model — fast-path answers only. */
  @IsOptional()
  @IsBoolean()
  instantOnly?: boolean;

  /** false = do not keep this chat in the user's history. */
  @IsOptional()
  @IsBoolean()
  saveHistory?: boolean;

  /** Default "near" distance (m) when the chat has none of its own. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50000)
  nearMeters?: number;

  /** How numbers in the answer sentence are written. */
  @IsOptional()
  @ValidateNested()
  @Type(() => AnswerFormatDto)
  format?: AnswerFormatDto;
}

/** `POST /gis/ai/export` — the features an answer matched, as a file. */
export class GisExportDto {
  @IsObject()
  operation!: Record<string, unknown>;

  @IsIn(['csv', 'geojson'])
  format!: 'csv' | 'geojson';
}

/** `POST /gis/ai/save-layer` — the matched features as a new layer. */
export class GisSaveLayerDto {
  @IsObject()
  operation!: Record<string, unknown>;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;
}

/** `POST /gis/ai/pin` — an answer as a Dashboard tile. */
export class GisPinDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  detail?: string;

  @IsOptional()
  @IsString()
  layerId?: string;
}

/** `PATCH /gis/ai/conversations/:id` — pin / unpin a chat. */
export class GisConversationPatchDto {
  @IsBoolean()
  pinned!: boolean;
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

  /** Language of the wording (assistant setting). */
  @IsOptional()
  @IsIn(['en', 'mr', 'hi'])
  language?: 'en' | 'mr' | 'hi';
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

/** `POST /gis/ai/icon-terms` — icon search words for a layer's markers. */
export class GisIconTermsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  /** A published layer: its description and field values give context. */
  @IsOptional()
  @IsUUID()
  layerId?: string;
}
