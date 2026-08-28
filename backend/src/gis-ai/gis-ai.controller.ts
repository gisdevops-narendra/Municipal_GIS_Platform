import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import { GisAiService } from './gis-ai.service';
import { GisChatDto } from './dto/chat.dto';
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

  @RequireMunicipalityMember()
  @Post('chat')
  chat(@CurrentAppUser() appUser: AppUser, @Body() dto: GisChatDto) {
    return this.gisAi.chat(appUser, dto);
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
  @RequireMunicipalityMember()
  @Post('execute-plan')
  executePlan(
    @CurrentAppUser() appUser: AppUser,
    @Body() body: { operation: AiGisOperation },
  ) {
    return this.gisAi.executePlan(appUser, body.operation);
  }
}
