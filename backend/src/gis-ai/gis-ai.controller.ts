import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { RequireAiAssistant } from './ai-assistant.guard';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisAiService } from './gis-ai.service';
import { GisChatDto, GisExplainDto, GisFeedbackDto, GisNarrateDto } from './dto/chat.dto';
import type { AiGisOperation } from './ai-plan.types';

/**
 * `/api/gis/ai/*` — the natural-language GIS assistant.
 *
 * A request flows: browser -> here -> Python AI/RAG service (produces a
 * structured plan) -> `GisQueryCompilerService` (validates the plan against
 * this municipality's real layers and compiles it to ONE read-only
 * parameterised PostGIS query) -> result rendered on the existing map +
 * Attribute Table. The LLM never receives or emits SQL.
 */
@Controller('gis/ai')
export class GisAiController {
  constructor(private readonly gisAi: GisAiService) {}

  /** Liveness + capability flags for the AI backend (any member). */
  @RequireMunicipalityMember()
  @Get('health')
  health() {
    return this.gisAi.health();
  }

  @RequireAiAssistant()
  @Post('chat')
  chat(@CurrentAppUser() appUser: AppUser, @Body() dto: GisChatDto) {
    return this.gisAi.chat(appUser, dto);
  }

  /** Friendlier wording of a chat answer from its computed facts (any
   *  member; the caller already holds the deterministic sentence). */
  /** Primes the local model's prompt cache; returns immediately. */
  @RequireAiAssistant()
  @Post('warm')
  warm(@CurrentAppUser() appUser: AppUser) {
    return this.gisAi.warm(appUser);
  }

  /** 👍/👎 on the caller's own answer. */
  @RequireAiAssistant()
  @Post('feedback')
  feedback(@CurrentAppUser() appUser: AppUser, @Body() dto: GisFeedbackDto) {
    return this.gisAi.feedback(appUser, dto.logId, dto.helpful);
  }

  /** Owner: recent questions of the municipality; `problems=true` keeps
   *  only 👎, errors, clarifications and unsupported ones. */
  @RequireMunicipalityOwner()
  @Get('logs')
  logs(
    @CurrentAppUser() appUser: AppUser,
    @Query('problems') problems?: string,
    @Query('limit') limit?: string,
  ) {
    return this.gisAi.logs(appUser, problems === 'true', Number(limit) || 100);
  }

  @RequireAiAssistant()
  @Post('narrate')
  narrate(@CurrentAppUser() appUser: AppUser, @Body() dto: GisNarrateDto) {
    return this.gisAi.narrate(appUser, dto);
  }

  /** Plain-language explanation of a raster analysis result (any member). */
  @RequireMunicipalityMember()
  @Post('explain')
  explain(@CurrentAppUser() appUser: AppUser, @Body() dto: GisExplainDto) {
    return this.gisAi.explain(appUser, dto);
  }

  /** Rebuild this municipality's RAG index (layer + field metadata). Owner
   *  only — it reads the full catalog and samples column values. */
  @RequireMunicipalityOwner()
  @Post('reindex')
  reindex(@CurrentAppUser() appUser: AppUser) {
    return this.gisAi.reindex(appUser);
  }

  /** Dev/QA: run a structured operation with no LLM. 403 unless
   *  `GIS_AI_ENABLE_RAW_PLAN=true`. */
  @RequireAiAssistant()
  @Post('execute-plan')
  executePlan(
    @CurrentAppUser() appUser: AppUser,
    @Body() body: { operation: AiGisOperation },
  ) {
    return this.gisAi.executePlan(appUser, body.operation);
  }
}
