import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GisModule } from '../gis/gis.module';
import { GisAiController } from './gis-ai.controller';
import { GisAiService } from './gis-ai.service';
import { AiClientService } from './ai-client.service';
import { LayerCatalogService } from './layer-catalog.service';
import { GisQueryCompilerService } from './gis-query-compiler.service';

/**
 * AI/ML GIS chatbot. Reuses `GisModule`'s layer metadata + authorization
 * (via `GisLayersService`) and the shared `PrismaService` connection —
 * this module adds only the LLM orchestration and the safe NL->SQL
 * compiler, not a parallel GIS stack.
 */
@Module({
  imports: [AuthModule, GisModule],
  controllers: [GisAiController],
  providers: [
    GisAiService,
    AiClientService,
    LayerCatalogService,
    GisQueryCompilerService,
  ],
})
export class GisAiModule {}
