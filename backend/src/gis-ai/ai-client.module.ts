import { Module } from '@nestjs/common';
import { AiClientService } from './ai-client.service';

/**
 * The HTTP client for the Python AI service on its own, so `GisModule`
 * (monitor alert summaries, semantic layer search) can use it without
 * importing `GisAiModule`, which itself imports `GisModule`.
 */
@Module({
  providers: [AiClientService],
  exports: [AiClientService],
})
export class AiClientModule {}
