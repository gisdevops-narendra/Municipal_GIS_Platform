import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { AiClientService } from './ai-client.service';
import { LayerCatalogService } from './layer-catalog.service';
import {
  GisQueryCompilerService,
  PlanValidationError,
} from './gis-query-compiler.service';
import type { AiGisOperation } from './ai-plan.types';
import type { GisChatDto } from './dto/chat.dto';

export interface GisChatResponse {
  answerKind: 'gis_operation' | 'clarification' | 'answer' | 'unsupported';
  explanation: string;
  clarification?: string;
  usedContext: string[];
  /** Present only for answerKind === 'gis_operation'. */
  operation?: AiGisOperation;
  /** The parameterised SQL the backend compiled and ran — shown to the
   *  user so it is obvious the LLM did not author it. */
  compiledSql?: string;
  compiledSummary?: string;
  result?: {
    layerId: string;
    layerCode: string;
    layerName: string;
    geometryType: string | null;
    matched: number;
    truncated: boolean;
    /** ECQL filter for the Attribute Table + WMS render (Query Builder
     *  shape). Null when nothing matched. */
    cql: string | null;
    /** Matched geometries (EPSG:4326 GeoJSON), capped, for the map
     *  highlight overlay. */
    geometries: Record<string, unknown>[];
  };
}

@Injectable()
export class GisAiService {
  private readonly logger = new Logger(GisAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
    private readonly catalog: LayerCatalogService,
    private readonly compiler: GisQueryCompilerService,
    private readonly config: ConfigService,
  ) {}

  async health(): Promise<Record<string, unknown>> {
    return this.ai.health();
  }

  async reindex(appUser: AppUser): Promise<Record<string, unknown>> {
    return this.ai.reindex(appUser.municipalityId);
  }

  async chat(appUser: AppUser, dto: GisChatDto): Promise<GisChatResponse> {
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { name: true },
    });
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });

    const catalogEntries = await this.catalog.buildForUser(appUser);

    const plan = await this.ai.plan({
      message: dto.message,
      municipality_id: appUser.municipalityId,
      municipality_name: municipality?.name,
      layers: this.catalog.toAiLayerInfo(catalogEntries),
      history: (dto.history ?? []).slice(-6).map((t) => ({
        role: t.role,
        content: t.content,
      })),
    });

    const usedContext = plan.used_context ?? [];

    if (plan.answer_kind !== 'gis_operation' || !plan.operation) {
      return {
        answerKind: plan.answer_kind,
        explanation: plan.explanation,
        clarification: plan.clarification ?? undefined,
        usedContext,
      };
    }

    if (!workspace) {
      return {
        answerKind: 'unsupported',
        explanation:
          'This municipality has no GIS workspace yet, so there is nothing to query.',
        usedContext,
      };
    }

    return this.runOperation(
      plan.operation,
      catalogEntries,
      workspace.id,
      plan.explanation,
      usedContext,
    );
  }

  /**
   * Compiles + runs a structured operation with NO LLM in the loop. Dev /
   * QA hook for the safe-execution half of the pipeline — gated by
   * `GIS_AI_ENABLE_RAW_PLAN=true`, off by default.
   */
  async executePlan(
    appUser: AppUser,
    operation: AiGisOperation,
  ): Promise<GisChatResponse> {
    if (this.config.get<string>('GIS_AI_ENABLE_RAW_PLAN') !== 'true') {
      throw new ForbiddenException('Raw plan execution is disabled.');
    }
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    if (!workspace) {
      return {
        answerKind: 'unsupported',
        explanation: 'This municipality has no GIS workspace yet.',
        usedContext: [],
      };
    }
    const catalogEntries = await this.catalog.buildForUser(appUser);
    return this.runOperation(
      operation,
      catalogEntries,
      workspace.id,
      'Executed the supplied structured operation.',
      [],
    );
  }

  private async runOperation(
    operation: AiGisOperation,
    catalogEntries: Awaited<ReturnType<LayerCatalogService['buildForUser']>>,
    workspaceId: string,
    explanation: string,
    usedContext: string[],
  ): Promise<GisChatResponse> {
    try {
      const compiled = this.compiler.compile(
        operation,
        catalogEntries,
        workspaceId,
      );
      const execution = await this.compiler.execute(compiled);
      const cql = this.compiler.buildCql(compiled.target, execution.ids);

      return {
        answerKind: 'gis_operation',
        explanation,
        operation,
        usedContext,
        compiledSql: compiled.sql,
        compiledSummary: compiled.summary,
        result: {
          layerId: compiled.target.layerId,
          layerCode: compiled.target.code,
          layerName: compiled.target.name,
          geometryType: compiled.target.geometryType,
          matched: execution.matched,
          truncated: execution.truncated,
          cql,
          geometries: execution.geometries,
        },
      };
    } catch (error) {
      if (error instanceof PlanValidationError) {
        return {
          answerKind: 'clarification',
          explanation,
          clarification: error.message,
          usedContext,
          operation,
        };
      }
      this.logger.error(
        `GIS AI query execution failed: ${(error as Error).message}`,
      );
      return {
        answerKind: 'unsupported',
        explanation:
          'I understood the request but the query failed to run. Try narrowing it or rephrasing.',
        usedContext,
        operation,
      };
    }
  }
}
