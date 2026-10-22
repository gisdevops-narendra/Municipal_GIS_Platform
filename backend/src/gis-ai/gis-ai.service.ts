import { AsyncLocalStorage } from 'node:async_hooks';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { GisGeometryType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { NetworkService } from '../gis/network.service';
import { RasterService } from '../gis/raster.service';
import { AiClientService } from './ai-client.service';
import { LayerCatalogService } from './layer-catalog.service';
import {
  GisQueryCompilerService,
  type CompiledNearest,
  DistanceNeededError,
  PlanValidationError,
  UnknownFieldError,
} from './gis-query-compiler.service';
import type { AggregateMetric, AiClarifyOption, AiGisOperation, AiInstruction } from './ai-plan.types';
import type {
  AnswerFormatDto,
  GisChatDto,
  GisExplainDto,
  GisExportDto,
  GisNarrateDto,
  GisPinDto,
  GisSaveLayerDto,
} from './dto/chat.dto';

type Catalog = Awaited<ReturnType<LayerCatalogService['buildForUser']>>;
type Geo = Record<string, unknown>;

export interface GisChatSelection {
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
   *  highlight overlay. Empty when `exact` — GeoServer draws the filtered
   *  layer itself. */
  geometries: Geo[];
  /** true: `cql` is the plan's own conditions (every match shows on the
   *  map and in the Attribute Table); false: an id list of the first rows. */
  exact?: boolean;
  /** EPSG:4326 [minX, minY, maxX, maxY] of every match, to zoom to. */
  bbox?: [number, number, number, number] | null;
}

export interface GisChatResponse {
  answerKind: 'gis_operation' | 'clarification' | 'answer' | 'unsupported';
  explanation: string;
  clarification?: string;
  usedContext: string[];
  /** Question-log row of this answer — the client sends it back with 👍/👎. */
  logId?: string;
  /** "fast" (answered without the language model), "model", or "choice"
   *  (a clicked option). */
  planner?: 'fast' | 'model' | 'choice' | null;
  /** Clickable choices: clarification answers, "Did you mean …". */
  options?: AiClarifyOption[];
  /** How the question was read (e.g. a corrected spelling). */
  notes?: string[];
  /** Suggested next questions shown under the answer. */
  followUps?: string[];
  /** Server-side chat this answer belongs to. */
  conversationId?: string;
  /** Standing instructions now in force in that chat. */
  instructions?: AiInstruction[];
  /** Present only for answerKind === 'gis_operation'. */
  operation?: AiGisOperation;
  /** The parameterised SQL the backend compiled and ran — shown to the
   *  user so it is obvious the LLM did not author it. */
  compiledSql?: string;
  compiledSummary?: string;
  /** The answer in a sentence, built from the computed numbers (never by
   *  the LLM) — correct by construction and instant. */
  answer?: string;
  /** The verified numbers behind `answer`; the client may send them to
   *  `/narrate` for a friendlier LLM wording. */
  facts?: Record<string, unknown>;
  /** The features the operation selected (map highlight + Attribute Table). */
  result?: GisChatSelection;
  aggregate?: {
    metric: AggregateMetric;
    metricLabel: string | null;
    groupLabel: string | null;
    rows: { group: string | null; value: number | null; count: number }[];
    truncated: boolean;
  };
  nearest?: {
    referenceLayer: string;
    referenceLabel: string | null;
    referenceCount: number;
    items: { id: number | string; label: string | null; distanceM: number }[];
  };
  buffer?: { distanceM: number; sources: number; areaM2: number | null };
  route?: {
    networkLayer: string;
    from: { label: string; layer: string; matches: number };
    to: { label: string; layer: string; matches: number };
    lengthM: number;
  };
  serviceArea?: {
    networkLayer: string;
    origin: { label: string; layer: string; matches: number };
    distanceM: number;
    roadLengthM: number;
  };
  /** Extra shapes to draw (buffer, route path, service area, reference). */
  overlays?: Geo[];
}

/** How one request writes numbers (the user's assistant settings); the
 *  answer builders read it through fmt / fmtDist / fmtArea. */
interface AnswerFormat {
  nf: Intl.NumberFormat;
  distanceUnit: 'auto' | 'm' | 'km';
  areaUnit: 'auto' | 'sqm' | 'ha' | 'acre';
}
const formatStore = new AsyncLocalStorage<AnswerFormat>();
const DEFAULT_FORMAT: AnswerFormat = {
  nf: new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }),
  distanceUnit: 'auto',
  areaUnit: 'auto',
};
function answerFormat(dto?: AnswerFormatDto): AnswerFormat {
  let nf = DEFAULT_FORMAT.nf;
  try {
    if (dto?.numberLocale) nf = new Intl.NumberFormat(dto.numberLocale, { maximumFractionDigits: 2 });
  } catch {
    // unknown locale: keep the default grouping
  }
  return { nf, distanceUnit: dto?.distanceUnit ?? 'auto', areaUnit: dto?.areaUnit ?? 'auto' };
}
const format = () => formatStore.getStore() ?? DEFAULT_FORMAT;
const fmt = (n: number | null | undefined) => (n == null ? '—' : format().nf.format(n));
const round2 = (n: number) => Math.round(n * 100) / 100;
const fmtDist = (m: number) => {
  const unit = format().distanceUnit;
  return unit === 'm' || (unit === 'auto' && m < 1000) ? `${fmt(Math.round(m))} m` : `${fmt(round2(m / 1000))} km`;
};
const fmtArea = (m2: number) => {
  const unit = format().areaUnit;
  if (unit === 'sqm' || (unit === 'auto' && m2 < 10000)) return `${fmt(Math.round(m2))} m²`;
  if (unit === 'acre') return `${fmt(round2(m2 / 4046.8564224))} acres`;
  return `${fmt(round2(m2 / 10000))} ha`;
};

/** A step of a chat in progress, streamed to the panel. */
export type ChatProgress = (stage: 'understanding' | 'planned' | 'running', detail?: string) => void;

const MULTI_TYPE: Record<string, string> = { POINT: 'MultiPoint', LINE: 'MultiLineString', POLYGON: 'MultiPolygon' };
/** Export / save-as-layer take every match up to this many features. */
const EXPORT_MAX_ROWS = 5000;
const METRIC_WORD: Record<AggregateMetric, string> = {
  count: 'number',
  sum: 'total',
  avg: 'average',
  min: 'minimum',
  max: 'maximum',
};

const HAVING_WORD: Record<string, string> = {
  '>': 'above',
  '>=': 'of at least',
  '<': 'below',
  '<=': 'of at most',
  '=': 'of exactly',
};

@Injectable()
export class GisAiService {
  private readonly logger = new Logger(GisAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiClientService,
    private readonly catalog: LayerCatalogService,
    private readonly compiler: GisQueryCompilerService,
    private readonly network: NetworkService,
    private readonly config: ConfigService,
    private readonly raster: RasterService,
  ) {}

  async health(): Promise<Record<string, unknown>> {
    return this.ai.health();
  }

  async reindex(appUser: AppUser): Promise<Record<string, unknown>> {
    return this.ai.reindex(appUser.municipalityId);
  }

  private queryLayerCheck: { at: number; available: boolean } | null = null;

  /** Whether GeoServer has the querylayer extension (queryCollection /
   *  collectGeometries in CQL), needed to filter by distance to another
   *  layer. Read from its WFS capabilities, cached for 10 minutes. */
  private async geoServerHasQueryLayer(): Promise<boolean> {
    if (this.queryLayerCheck && Date.now() - this.queryLayerCheck.at < 10 * 60 * 1000) {
      return this.queryLayerCheck.available;
    }
    let available = false;
    try {
      const base = this.config.getOrThrow<string>('GEOSERVER_URL').replace(/\/+$/, '');
      const response = await fetch(`${base}/ows?service=WFS&version=1.1.0&request=GetCapabilities`, {
        signal: AbortSignal.timeout(5000),
      });
      available = response.ok && /<[^>]*FunctionName[^>]*>\s*queryCollection\s*</i.test(await response.text());
    } catch {
      available = false;
    }
    this.queryLayerCheck = { at: Date.now(), available };
    return available;
  }

  /** Called when the AI Assistant panel opens: primes the local model's
   *  prompt cache with exactly the prefix /chat will send, so the first
   *  question doesn't pay the cold read (~40 s on CPU). Returns at once. */
  async warm(appUser: AppUser): Promise<{ ok: true }> {
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { name: true },
    });
    const catalogEntries = await this.catalog.buildForUser(appUser);
    void this.ai
      .warm({
        message: '',
        municipality_id: appUser.municipalityId,
        municipality_name: municipality?.name,
        layers: this.catalog.toAiLayerInfo(catalogEntries),
        history: [],
      })
      .catch((err: Error) => this.logger.warn(`AI warm-up failed: ${err.message}`));
    return { ok: true };
  }

  /** Answers a question and records it in ai_query_logs (question, path,
   *  plan, result count, time, error) so failures and slow answers can be
   *  found, and the user can rate the answer. Logging never fails a chat. */
  async chat(appUser: AppUser, dto: GisChatDto, signal?: AbortSignal, progress?: ChatProgress): Promise<GisChatResponse> {
    return formatStore.run(answerFormat(dto.format), () => this.chatTurn(appUser, dto, signal, progress));
  }

  private async chatTurn(
    appUser: AppUser,
    dto: GisChatDto,
    signal?: AbortSignal,
    progress?: ChatProgress,
  ): Promise<GisChatResponse> {
    const started = Date.now();
    progress?.('understanding');
    // Server-side memory: the chat's own turns give the history and the
    // previous plan, so follow-ups work after a reload too. With history
    // off ("Save chat history" setting) nothing is kept: the panel's own
    // turns stand in for the memory.
    const keep = dto.saveHistory !== false;
    const conversation = keep ? await this.openConversation(appUser, dto.conversationId, dto.message) : null;
    const memory = conversation ? await this.conversationMemory(conversation.id) : { history: [], previous: null };
    const request: GisChatDto = {
      ...dto,
      history: memory.history.length ? memory.history : dto.history,
      previousOperation: (memory.previous as Record<string, unknown> | null) ?? dto.previousOperation,
    };
    let instructions = ((conversation?.instructions as unknown as AiInstruction[]) ?? []);
    let response: GisChatResponse & { instructionAction?: 'add' | 'clear'; instructionAdded?: AiInstruction };
    try {
      response = await this.answer(appUser, request, instructions, signal, progress);
    } catch (error) {
      await this.logQuestion(appUser, dto.message, started, {
        answerKind: signal?.aborted ? 'cancelled' : 'error',
        error: error instanceof Error ? error.message : String(error),
        conversationId: conversation?.id,
      });
      throw error;
    }
    if (conversation && response.instructionAction) {
      instructions = response.instructionAction === 'clear' ? [] : [...instructions, response.instructionAdded!];
      await this.prisma.aiConversation.update({
        where: { id: conversation.id },
        data: { instructions: instructions as unknown as Prisma.InputJsonValue },
      });
    } else if (conversation) {
      await this.prisma.aiConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    }
    const { instructionAction: _a, instructionAdded: _b, ...shown } = response;
    const logId = await this.logQuestion(appUser, dto.message, started, {
      answerKind: response.answerKind,
      planner: response.planner ?? null,
      operation: response.operation,
      explanation: response.answer ?? response.clarification ?? response.explanation,
      matched: response.result?.matched ?? null,
      conversationId: conversation?.id,
      response: conversation ? stripForStorage(shown) : undefined,
    });
    return { ...shown, logId: logId ?? undefined, conversationId: conversation?.id, instructions };
  }

  /** The caller's chat, or a new one titled by its first question. */
  private async openConversation(appUser: AppUser, id: string | undefined, firstQuestion: string) {
    if (id) {
      const found = await this.prisma.aiConversation.findFirst({
        where: { id, userId: appUser.id, municipalityId: appUser.municipalityId },
      });
      if (found) return found;
    }
    return this.prisma.aiConversation.create({
      data: { municipalityId: appUser.municipalityId, userId: appUser.id, title: firstQuestion.slice(0, 120) },
    });
  }

  /** Last turns as chat history + the last operation that ran. */
  private async conversationMemory(conversationId: string) {
    const rows = await this.prisma.aiQueryLog.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: 6,
      select: { question: true, explanation: true, operation: true, answerKind: true },
    });
    const history: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const r of [...rows].reverse()) {
      history.push({ role: 'user', content: r.question });
      if (r.explanation) history.push({ role: 'assistant', content: r.explanation });
    }
    // A clarification's half-built plan counts too: "yes, use length" completes
    // "display the longest river", not whatever ran before it.
    const previous =
      rows.find((r) => (r.answerKind === 'gis_operation' || r.answerKind === 'clarification') && r.operation)
        ?.operation ?? null;
    return { history: history.slice(-6), previous };
  }

  /** The user's chats, newest first. */
  async conversations(appUser: AppUser) {
    const rows = await this.prisma.aiConversation.findMany({
      where: { userId: appUser.id, municipalityId: appUser.municipalityId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      select: { id: true, title: true, updatedAt: true, pinned: true },
    });
    return rows;
  }

  /** One chat with its turns, to reopen it. */
  async conversation(appUser: AppUser, id: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, userId: appUser.id, municipalityId: appUser.municipalityId },
    });
    if (!conversation) throw new NotFoundException('That chat was not found.');
    const turns = await this.prisma.aiQueryLog.findMany({
      where: { conversationId: id },
      orderBy: { createdAt: 'asc' },
      select: { id: true, question: true, response: true, feedback: true, answerKind: true, error: true },
    });
    return {
      id: conversation.id,
      title: conversation.title,
      instructions: conversation.instructions,
      turns: turns.map((t) => ({
        question: t.question,
        response: t.response ?? { answerKind: t.answerKind, explanation: t.error ?? '', usedContext: [] },
        logId: t.id,
        feedback: t.feedback,
      })),
    };
  }

  async deleteConversation(appUser: AppUser, id: string) {
    const { count } = await this.prisma.aiConversation.deleteMany({
      where: { id, userId: appUser.id, municipalityId: appUser.municipalityId },
    });
    if (count === 0) throw new NotFoundException('That chat was not found.');
    await this.prisma.aiQueryLog.updateMany({ where: { conversationId: id }, data: { conversationId: null, response: Prisma.DbNull } });
    return { ok: true };
  }

  /** Remove one standing instruction (the chip's ✕). */
  async removeInstruction(appUser: AppUser, id: string, index: number) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, userId: appUser.id, municipalityId: appUser.municipalityId },
    });
    if (!conversation) throw new NotFoundException('That chat was not found.');
    const list = ((conversation.instructions as unknown as AiInstruction[]) ?? []).filter((_, i) => i !== index);
    await this.prisma.aiConversation.update({ where: { id }, data: { instructions: list as unknown as Prisma.InputJsonValue } });
    return { instructions: list };
  }

  private async logQuestion(
    appUser: AppUser,
    question: string,
    started: number,
    entry: {
      answerKind: string;
      planner?: string | null;
      operation?: AiGisOperation;
      explanation?: string;
      matched?: number | null;
      error?: string;
      conversationId?: string;
      response?: Prisma.InputJsonValue;
    },
  ): Promise<string | null> {
    try {
      const row = await this.prisma.aiQueryLog.create({
        data: {
          municipalityId: appUser.municipalityId,
          userId: appUser.id,
          question: question.slice(0, 2000),
          answerKind: entry.answerKind,
          planner: entry.planner ?? null,
          operation: entry.operation ? (entry.operation as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
          explanation: entry.explanation?.slice(0, 1000) ?? null,
          matched: entry.matched ?? null,
          durationMs: Date.now() - started,
          error: entry.error?.slice(0, 1000) ?? null,
          conversationId: entry.conversationId ?? null,
          response: entry.response ?? Prisma.DbNull,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      this.logger.warn(`Could not log AI question: ${(err as Error).message}`);
      return null;
    }
  }

  /** 👍/👎 on the caller's own answer. */
  async feedback(appUser: AppUser, logId: string, helpful: boolean): Promise<{ ok: true }> {
    const { count } = await this.prisma.aiQueryLog.updateMany({
      where: { id: logId, userId: appUser.id, municipalityId: appUser.municipalityId },
      data: { feedback: helpful ? 1 : -1, feedbackAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('That answer was not found.');
    return { ok: true };
  }

  /** Example questions from the caller's real layers, each one plannable. */
  async suggestions(appUser: AppUser): Promise<string[]> {
    const catalogEntries = await this.catalog.buildForUser(appUser);
    return this.ai.suggest(this.catalog.toAiLayerInfo(catalogEntries));
  }

  /** Owner: the municipality's recent questions, newest first. */
  async logs(appUser: AppUser, onlyProblems: boolean, limit: number) {
    const rows = await this.prisma.aiQueryLog.findMany({
      where: {
        municipalityId: appUser.municipalityId,
        ...(onlyProblems
          ? { OR: [{ feedback: -1 }, { answerKind: { in: ['error', 'clarification', 'unsupported'] } }] }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.userId))] } },
      select: { id: true, fullName: true },
    });
    const names = new Map(users.map((u) => [u.id, u.fullName]));
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      user: names.get(r.userId) ?? null,
      question: r.question,
      answerKind: r.answerKind,
      planner: r.planner,
      matched: r.matched,
      durationMs: r.durationMs,
      explanation: r.explanation,
      error: r.error,
      feedback: r.feedback,
    }));
  }

  private async answer(
    appUser: AppUser,
    dto: GisChatDto,
    instructions: AiInstruction[] = [],
    signal?: AbortSignal,
    progress?: ChatProgress,
  ): Promise<GisChatResponse & { instructionAction?: 'add' | 'clear'; instructionAdded?: AiInstruction }> {
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { name: true },
    });
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });

    let catalogEntries = await this.catalog.buildForUser(appUser);
    // "Layers the assistant may use" (setting): never widen past what the
    // user can see anyway — buildForUser already applied permissions.
    if (dto.layerIds?.length) {
      const allowed = new Set(dto.layerIds);
      catalogEntries = catalogEntries.filter((e) => allowed.has(e.layerId));
    }
    // "Only the current map view" — a condition the backend adds, never the model.
    const inView = (op: AiGisOperation): AiGisOperation => (dto.viewBbox ? { ...op, view_bbox: dto.viewBbox } : op);
    const layerName = (code?: string | null) =>
      catalogEntries.find((e) => e.code === code || e.name === code)?.name ?? code ?? undefined;

    // A clicked option carries its plan: run it, no model call.
    if (dto.resolvedOperation) {
      if (!workspace) {
        return { answerKind: 'unsupported', explanation: 'This municipality has no GIS workspace yet.', usedContext: [] };
      }
      const { learn_alias: learn, ...resolved } = dto.resolvedOperation as unknown as AiGisOperation;
      if (learn?.layer_id && learn.field && learn.alias) {
        // The user told us what they call this field: no need to ask again.
        await this.catalog.learnAlias(learn.layer_id, learn.field, learn.alias);
        void this.ai.reindex(appUser.municipalityId).catch(() => undefined);
      }
      progress?.('running', layerName((resolved as AiGisOperation).target_layer));
      const chosen = await this.runOperation(
        appUser,
        inView(resolved as AiGisOperation),
        catalogEntries,
        workspace.id,
        'Your choice.',
        [],
      );
      return { ...chosen, planner: 'choice', followUps: this.followUps(chosen, catalogEntries, dto.message) };
    }

    await this.catalog.addMatchingValues(catalogEntries, dto.message);

    const plan = await this.ai.plan({
      message: dto.message,
      municipality_id: appUser.municipalityId,
      municipality_name: municipality?.name,
      layers: this.catalog.toAiLayerInfo(catalogEntries),
      history: (dto.history ?? []).slice(-6).map((t) => ({
        role: t.role,
        content: t.content,
      })),
      previous_operation: dto.previousOperation,
      // The user's default "near" distance counts until the chat sets its own.
      instructions:
        dto.nearMeters && !instructions.some((r) => r.near_m)
          ? [{ text: `near = ${dto.nearMeters} m (assistant setting)`, near_m: dto.nearMeters }, ...instructions]
          : instructions,
      instant_only: dto.instantOnly ?? false,
    }, signal);
    progress?.('planned', plan.operation ? layerName(plan.operation.target_layer) : undefined);

    const usedContext = plan.used_context ?? [];

    const planner = plan.planner ?? null;
    const guidance = { options: plan.options ?? [], notes: plan.notes ?? [] };
    if (plan.answer_kind !== 'gis_operation' || !plan.operation) {
      return {
        answerKind: plan.answer_kind,
        explanation: plan.explanation,
        clarification: plan.clarification ?? undefined,
        // The plan a clarification is about, so the reply ("yes, length")
        // completes it (see conversationMemory).
        operation: plan.answer_kind === 'clarification' ? plan.operation ?? undefined : undefined,
        usedContext,
        planner,
        ...guidance,
        instructionAction: plan.instruction_action ?? undefined,
        instructionAdded: plan.instruction ?? undefined,
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

    progress?.('running', layerName(plan.operation.target_layer));
    const response = await this.runOperation(
      appUser,
      inView(plan.operation),
      catalogEntries,
      workspace.id,
      plan.explanation,
      usedContext,
    );
    return {
      ...response,
      followUps: this.followUps(response, catalogEntries, dto.message),
      planner,
      // Options from validation (field / distance choice) win over hints.
      options: response.options?.length ? response.options : guidance.options,
      notes: guidance.notes,
    };
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
      appUser,
      operation,
      catalogEntries,
      workspace.id,
      'Executed the supplied structured operation.',
      [],
    );
  }

  /**
   * LLM wording for a chat answer the backend already computed. Optional
   * and slow (one more local-model call), so the panel shows `answer` at
   * once and swaps this in when it arrives; `text` is null when the model
   * failed or introduced a number that is not in the facts.
   */
  async narrate(appUser: AppUser, dto: GisNarrateDto): Promise<{ text: string | null }> {
    // Off by default: on a CPU-only host the wording call takes 3-14 s and
    // evicts the plan prompt from Ollama's cache, so the NEXT question
    // re-reads ~3k tokens (~35 s instead of ~7 s). The computed answer is
    // exact anyway. GIS_AI_QUERY_NARRATION=true turns it back on (e.g. GPU).
    if (this.config.get<string>('GIS_AI_QUERY_NARRATION') !== 'true') {
      return { text: null };
    }
    return this.narrateFacts(appUser, 'query', dto.question, dto.facts, dto.language);
  }

  /** Plain-language explanation of a finished Raster Analysis result, from
   *  the facts the panel shows (and its zone/site table, if any). */
  async explain(appUser: AppUser, dto: GisExplainDto): Promise<{ text: string | null }> {
    const facts: Record<string, unknown> = {
      analysis: dto.title,
      // "label: value" lines, not {label: value}: the grounding check only
      // reads values, so numbers in labels ("< 8.5°") were treated as invented.
      results: dto.facts.map((f) => `${f.label}: ${f.value}`),
    };
    if (dto.rows?.length) facts['table'] = dto.rows.slice(0, 25);
    return this.narrateFacts(
      appUser,
      'raster',
      `Explain this ${dto.title} result in plain language.`,
      facts,
    );
  }

  private async narrateFacts(
    appUser: AppUser,
    kind: 'query' | 'raster',
    question: string,
    facts: Record<string, unknown>,
    language?: 'en' | 'mr' | 'hi',
  ): Promise<{ text: string | null }> {
    const municipality = await this.prisma.municipality.findUnique({
      where: { id: appUser.municipalityId },
      select: { name: true },
    });
    const result = await this.ai.narrate({
      kind,
      question,
      facts,
      municipality_name: municipality?.name,
      language,
    });
    return { text: result.grounded && result.text.trim() ? result.text.trim() : null };
  }

  // ------------------------------------------------------------------

  /** Up to three next questions for an answer, built from the target
   *  layer's profiled fields — each in a form the planner answers. */
  private followUps(response: GisChatResponse, catalog: Catalog, question: string): string[] {
    const op = response.operation;
    if (response.answerKind !== 'gis_operation' || !op) return [];
    const target = catalog.find((e) => e.code === op.target_layer || e.name === op.target_layer);
    if (!target) return [];
    const name = target.name.replace(/_/g, ' ');
    const usable = target.columns.filter((c) => c.role !== 'hidden' && c.role !== 'id');
    const category = usable.find((c) => c.role === 'category' && c.kind === 'text' && c.name !== op.group_by);
    const measure = usable.find((c) => c.role === 'measure');
    const spatialRef = op.spatial_filter?.reference_layer;
    const area =
      catalog.find((e) => e.geometryType === 'POLYGON' && (e.code === spatialRef || e.name === spatialRef)) ??
      catalog.find((e) => e.geometryType === 'POLYGON' && e.layerId !== target.layerId && e.code !== op.group_by_layer);
    const out: string[] = [];
    const kind = op.kind ?? 'select';
    if (kind === 'aggregate' && op.group_by && response.aggregate?.rows.length) {
      const top = [...response.aggregate.rows].sort((a, b) => (b.value ?? 0) - (a.value ?? 0))[0]?.group;
      if (top) out.push(`Show ${name} that are ${top}`);
    }
    if (kind === 'nearest' && op.reference_layer) {
      const ref = catalog.find((e) => e.code === op.reference_layer || e.name === op.reference_layer);
      if (ref) out.push(`Show ${name} within 500 m of ${ref.name.replace(/_/g, ' ')}`);
    }
    if (category) out.push(`Count ${name} by ${category.name}`);
    if (area && target.geometryType !== 'POLYGON') out.push(`How many ${name} are there in each ${area.name.replace(/_/g, ' ')}`);
    if (measure && kind === 'select' && !op.order_by) out.push(`Top 5 ${name} by ${measure.name}`);
    const asked = question.trim().toLowerCase();
    return [...new Set(out)].filter((q) => q.toLowerCase() !== asked).slice(0, 3);
  }

  /** The features an answer matched, as CSV or GeoJSON. */
  async exportFeatures(appUser: AppUser, dto: GisExportDto): Promise<{ filename: string; mime: string; body: string }> {
    const { compiled } = await this.compileForUser(appUser, dto.operation);
    const rows = (await this.compiler.exportRows(compiled)).map(plainRow);
    const base = `${compiled.target.name.replace(/[^\w-]+/g, '_')}_${new Date().toISOString().slice(0, 10)}`;
    if (dto.format === 'geojson') {
      const features = rows.map(({ __geojson, ...properties }) => ({
        type: 'Feature',
        geometry: typeof __geojson === 'string' ? JSON.parse(__geojson) : null,
        properties,
      }));
      return {
        filename: `${base}.geojson`,
        mime: 'application/geo+json',
        body: JSON.stringify({ type: 'FeatureCollection', features }),
      };
    }
    const columns = rows.length ? Object.keys(rows[0]).filter((k) => k !== '__geojson') : [];
    const cell = (v: unknown) => {
      const text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
      return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const lines = [columns.map(cell).join(','), ...rows.map((r) => columns.map((c) => cell(r[c])).join(','))];
    // BOM: Excel then opens Marathi / Hindi text correctly.
    return { filename: `${base}.csv`, mime: 'text/csv; charset=utf-8', body: '\uFEFF' + lines.join('\r\n') };
  }

  /** The features an answer matched, saved as a new layer of the user's. */
  async saveAsLayer(appUser: AppUser, dto: GisSaveLayerDto) {
    const { compiled } = await this.compileForUser(appUser, dto.operation);
    const target = compiled.target;
    const multi = MULTI_TYPE[target.geometryType ?? ''];
    if (!multi) throw new BadRequestException('Only point, line and polygon results can be saved as a layer.');
    const output = await this.raster.prepareVectorOutput(appUser, dto.name);
    const srid = Number(String(output.workspace.defaultCrs ?? '').split(':').pop()) || 32643;
    const skip = new Set(['ogc_fid', 'gis_workspace_id', 'geom', target.pkColumn.toLowerCase()]);
    const cols = target.columns
      .filter((c) => c.kind !== 'geometry' && !skip.has(c.name.toLowerCase()))
      .map((c) => `x."${c.name}"`);
    await this.prisma.$executeRawUnsafe(
      `CREATE TABLE "${output.table}" AS SELECT ${cols.length ? cols.join(', ') + ', ' : ''}` +
        `ST_Multi(ST_Transform(x."${target.geomColumn}", ${srid}))::geometry(${multi}, ${srid}) AS geom ` +
        `FROM "${target.table}" x WHERE x."${target.pkColumn}" IN (SELECT q.__id FROM (${compiled.sql}) q)`,
      ...compiled.params,
    );
    await this.prisma.$executeRawUnsafe(`ALTER TABLE "${output.table}" ADD COLUMN ogc_fid SERIAL PRIMARY KEY`);
    const [{ n }] = await this.prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${output.table}"`);
    if (n === 0) {
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${output.table}"`);
      throw new BadRequestException('The answer matched no features, so there is nothing to save.');
    }
    return this.raster.publishVectorTable(appUser, output, {
      name: dto.name,
      geometryType: target.geometryType as GisGeometryType,
      description: `Saved from the AI Assistant — ${compiled.summary}`,
      rasterAnalysis: false,
    });
  }

  /** An answer as a Dashboard tile (the Dashboard's pins). */
  async pin(appUser: AppUser, dto: GisPinDto) {
    return this.prisma.rasterPin.create({
      data: {
        municipalityId: appUser.municipalityId,
        createdById: appUser.id,
        title: dto.title,
        value: dto.value,
        detail: dto.detail,
        layerId: dto.layerId,
      },
    });
  }

  async setConversationPinned(appUser: AppUser, id: string, pinned: boolean) {
    const { count } = await this.prisma.aiConversation.updateMany({
      where: { id, userId: appUser.id, municipalityId: appUser.municipalityId },
      data: { pinned },
    });
    if (count === 0) throw new NotFoundException('That chat was not found.');
    return { ok: true };
  }

  /** "Delete all my chats" (privacy setting). The question log keeps the
   *  questions for the Owner, without their stored answers. */
  async deleteAllConversations(appUser: AppUser) {
    const rows = await this.prisma.aiConversation.findMany({
      where: { userId: appUser.id, municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    if (ids.length) {
      await this.prisma.aiQueryLog.updateMany({
        where: { conversationId: { in: ids } },
        data: { conversationId: null, response: Prisma.DbNull },
      });
      await this.prisma.aiConversation.deleteMany({ where: { id: { in: ids } } });
    }
    return { deleted: ids.length };
  }

  /** A client-sent plan, compiled against the caller's own layers —
   *  validated exactly like a chat answer's plan. */
  private async compileForUser(appUser: AppUser, raw: Record<string, unknown>) {
    const workspace = await this.prisma.gISWorkspace.findUnique({
      where: { municipalityId: appUser.municipalityId },
      select: { id: true },
    });
    if (!workspace) throw new BadRequestException('This municipality has no GIS workspace yet.');
    const catalogEntries = await this.catalog.buildForUser(appUser);
    const op = raw as unknown as AiGisOperation;
    try {
      const compiled = this.compiler.compile({ ...op, limit: op.limit ?? EXPORT_MAX_ROWS }, catalogEntries, workspace.id);
      return { compiled };
    } catch (error) {
      if (error instanceof PlanValidationError) throw new BadRequestException(error.message);
      throw error;
    }
  }

  private async runOperation(
    appUser: AppUser,
    operation: AiGisOperation,
    catalogEntries: Catalog,
    workspaceId: string,
    explanation: string,
    usedContext: string[],
  ): Promise<GisChatResponse> {
    const base = { answerKind: 'gis_operation' as const, explanation, operation, usedContext };
    try {
      switch (operation.kind ?? 'select') {
        case 'select':
          return { ...base, ...(await this.runSelect(operation, catalogEntries, workspaceId)) };
        case 'aggregate':
          return { ...base, ...(await this.runAggregate(operation, catalogEntries, workspaceId)) };
        case 'nearest':
          return { ...base, ...(await this.runNearest(operation, catalogEntries, workspaceId)) };
        case 'buffer':
          return { ...base, ...(await this.runBuffer(operation, catalogEntries, workspaceId)) };
        case 'route':
          return { ...base, ...(await this.runRoute(appUser, operation, catalogEntries, workspaceId)) };
        case 'service_area':
          return { ...base, ...(await this.runServiceArea(appUser, operation, catalogEntries, workspaceId)) };
        default:
          throw new PlanValidationError(
            `I can't run a "${String(operation.kind)}" operation.`,
          );
      }
    } catch (error) {
      if (error instanceof UnknownFieldError) {
        return { ...base, answerKind: 'clarification', clarification: error.message, options: fieldChoices(operation, error) };
      }
      if (error instanceof DistanceNeededError) {
        return { ...base, answerKind: 'clarification', clarification: error.message, options: distanceChoices(operation) };
      }
      if (error instanceof PlanValidationError) {
        return { ...base, answerKind: 'clarification', clarification: error.message };
      }
      if (error instanceof HttpException && error.getStatus() < 500) {
        // e.g. the network tools: "not connected", no module access, ...
        const body = error.getResponse() as { message?: string | string[] } | string;
        const message =
          typeof body === 'string'
            ? body
            : Array.isArray(body.message)
              ? body.message.join(' ')
              : body.message ?? error.message;
        return { ...base, answerKind: 'clarification', clarification: message };
      }
      this.logger.error(
        `GIS AI ${operation.kind} execution failed: ${(error as Error).message}`,
      );
      return {
        ...base,
        answerKind: 'unsupported',
        explanation:
          'I understood the request but the query failed to run. Try narrowing it or rephrasing.',
      };
    }
  }

  /** The operation's starting features as a map/table selection. */
  private async selection(
    operation: AiGisOperation,
    catalogEntries: Catalog,
    workspaceId: string,
  ) {
    const compiled = this.compiler.compile(operation, catalogEntries, workspaceId);
    // Preferred: GeoServer filters the layer by the plan's own conditions —
    // all matches on the map / in the table, no geometries sent.
    const exactCql = this.compiler.conditionCql(operation, catalogEntries, {
      queryLayer: await this.geoServerHasQueryLayer(),
    });
    if (exactCql) {
      const { matched, bbox } = await this.compiler.summarize(compiled);
      const result: GisChatSelection = {
        layerId: compiled.target.layerId,
        layerCode: compiled.target.code,
        layerName: compiled.target.name,
        geometryType: compiled.target.geometryType,
        matched,
        truncated: false,
        cql: matched > 0 ? exactCql : null,
        geometries: [],
        exact: true,
        bbox,
      };
      return { compiled, result };
    }
    const execution = await this.compiler.execute(compiled);
    const result: GisChatSelection = {
      layerId: compiled.target.layerId,
      layerCode: compiled.target.code,
      layerName: compiled.target.name,
      geometryType: compiled.target.geometryType,
      matched: execution.matched,
      truncated: execution.truncated,
      cql: this.compiler.buildCql(compiled.target, execution.ids),
      geometries: execution.geometries,
      exact: false,
    };
    return { compiled, result, ranked: execution.ranked };
  }

  private async runSelect(op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    const selected = await this.selection(op, catalogEntries, ws);
    const { compiled, result } = selected;
    const ranked = 'ranked' in selected ? selected.ranked : undefined;
    let answer =
      result.matched === 0
        ? `No ${result.layerName} features match.`
        : `Found ${fmt(result.matched)} ${result.layerName} feature${result.matched === 1 ? '' : 's'}` +
          (result.truncated ? ` (the first ${fmt(result.geometries.length)} are shown on the map).` : '.');
    // "The longest river": name the winner(s) and the value they won with,
    // straight from the rows the map shows.
    const rank = compiled.ranking;
    if (rank && ranked?.length && compiled.limitAsked && ranked.length <= 5) {
      const unit = rank.unit ? ` ${rank.unit}` : '';
      const one = (r: { label: string | null; value: number | null }) =>
        `${r.label ?? `${result.layerName} feature`} (${rank.field} ${fmt(r.value)}${unit})`;
      answer =
        ranked.length === 1
          ? `${one(ranked[0])} has the ${rank.desc ? 'highest' : 'lowest'} ${rank.field} of ${result.layerName}.`
          : `${rank.desc ? 'Highest' : 'Lowest'} ${rank.field} of ${result.layerName}: ${ranked.map(one).join(', ')}.`;
    }
    return {
      compiledSql: compiled.sql,
      compiledSummary: compiled.summary,
      result,
      answer,
      // `query` tells the narrator exactly WHICH features matched, so it
      // describes them instead of guessing (e.g. "type = Not Working").
      facts: {
        operation: 'select',
        layer: result.layerName,
        query: compiled.summary,
        matched: result.matched,
        ...(rank && ranked?.length ? { ranked: ranked.map((r) => ({ name: r.label, [rank.field]: r.value })) } : {}),
      },
    };
  }

  private async runAggregate(op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    const compiled = this.compiler.compileAggregate(op, catalogEntries, ws);
    const { rows, truncated } = await this.compiler.runAggregate(compiled);
    const { result } = await this.selection(op, catalogEntries, ws);
    const layer = compiled.target.name;
    const metric = compiled.metric;
    const what =
      metric === 'count'
        ? `${layer} features`
        : `${METRIC_WORD[metric]} ${compiled.metricLabel} of ${layer}`;

    let answer: string;
    const facts: Record<string, unknown> = {
      operation: 'aggregate',
      layer,
      query: compiled.summary,
      statistic: metric,
      field: compiled.metricLabel,
      groupedBy: compiled.groupLabel,
    };
    if (!compiled.groupLabel) {
      const v = rows[0]?.value ?? null;
      const n = rows[0]?.count ?? 0;
      answer =
        metric === 'count'
          ? `There ${n === 1 ? 'is' : 'are'} ${fmt(n)} ${layer} feature${n === 1 ? '' : 's'} matching the request.`
          : n === 0
            ? `No ${layer} features match, so there is no ${METRIC_WORD[metric]}.`
            : `The ${what} is ${fmt(v)} (over ${fmt(n)} feature${n === 1 ? '' : 's'}).`;
      Object.assign(facts, { value: v, features: n });
    } else {
      const total = rows.reduce((s, r) => s + r.count, 0);
      const valued = rows.filter((r) => r.value != null);
      const top = valued[0];
      const bottom = valued[valued.length - 1];
      const zeroes = rows.filter((r) => r.count === 0).length;
      const groupName = compiled.groupLabel;
      answer = op.limit && !op.having_op
        ? `${op.order_desc === false ? 'Fewest' : 'Most'} ${layer} features by ${groupName}: ` +
          `${valued.map((r) => `${r.group ?? '(blank)'} (${fmt(r.value)})`).join(', ')}.`
        : op.having_op
        ? `${fmt(rows.length)} group${rows.length === 1 ? '' : 's'} of ${groupName} ${rows.length === 1 ? 'has' : 'have'} ` +
          `${metric === 'count' ? 'a count' : `a ${METRIC_WORD[metric]}`} ${HAVING_WORD[op.having_op] ?? op.having_op} ${fmt(op.having_value ?? 0)}` +
          (rows.length ? `: ${valued.slice(0, 10).map((r) => `${r.group ?? '(blank)'} (${fmt(r.value)})`).join(', ')}${rows.length > 10 ? ', …' : ''}.` : '.')
        : `${metric === 'count' ? 'Counted' : `Computed the ${METRIC_WORD[metric]} ${compiled.metricLabel} for`} ` +
        `${fmt(total)} ${layer} feature${total === 1 ? '' : 's'} across ${fmt(rows.length)}${truncated ? '+' : ''} group${rows.length === 1 ? '' : 's'} of ${groupName}.` +
        (top ? ` Highest: ${top.group ?? '(blank)'} (${fmt(top.value)}).` : '') +
        (bottom && bottom !== top ? ` Lowest: ${bottom.group ?? '(blank)'} (${fmt(bottom.value)}).` : '') +
        (zeroes ? ` ${fmt(zeroes)} group${zeroes === 1 ? ' has' : 's have'} none.` : '');
      Object.assign(facts, {
        totalFeatures: total,
        groups: rows.length,
        groupsWithNone: zeroes,
        highest: valued.slice(0, 5).map((r) => ({ group: r.group, value: r.value })),
        lowest: valued.slice(-3).map((r) => ({ group: r.group, value: r.value })),
      });
    }

    return {
      compiledSql: compiled.sql,
      compiledSummary: compiled.summary,
      result,
      answer,
      facts,
      aggregate: {
        metric,
        metricLabel: compiled.metricLabel,
        groupLabel: compiled.groupLabel,
        rows,
        truncated,
      },
    };
  }

  private async runNearest(op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    const compiled = this.compiler.compileNearest(op, catalogEntries, ws);
    if (compiled.perReference) return this.runNearestPerReference(compiled);
    const { reference, rows } = await this.compiler.runNearest(compiled);
    const layer = compiled.target.name;
    const refName = reference.count === 1 && reference.label
      ? `"${reference.label}" (${compiled.reference.name})`
      : `the ${fmt(reference.count)} selected ${compiled.reference.name} features`;
    const items = rows.map((r) => ({ id: r.id, label: r.label, distanceM: r.distanceM }));
    const answer = rows.length
      ? `Nearest ${layer} to ${refName}, straight-line: ` +
        rows.map((r) => `${r.label ?? `#${r.id}`} — ${fmtDist(r.distanceM)}`).join('; ') + '.'
      : `No ${layer} features match, so none could be ranked.`;
    const geometries = rows.map((r) => r.geometry).filter((g): g is Geo => g !== null);
    const result: GisChatSelection = {
      layerId: compiled.target.layerId,
      layerCode: compiled.target.code,
      layerName: layer,
      geometryType: compiled.target.geometryType,
      matched: rows.length,
      truncated: false,
      cql: this.compiler.buildCql(compiled.target, rows.map((r) => r.id)),
      geometries,
    };
    return {
      compiledSql: compiled.sql,
      compiledSummary: compiled.summary,
      result,
      answer,
      facts: {
        operation: 'nearest',
        layer,
        from: refName,
        results: rows.map((r) => ({ name: r.label ?? `#${r.id}`, distance: fmtDist(r.distanceM) })),
      },
      nearest: {
        referenceLayer: compiled.reference.name,
        referenceLabel: reference.label,
        referenceCount: reference.count,
        items,
      },
      overlays: reference.geometry ? [reference.geometry] : [],
    };
  }

  /** "Nearest X to each Y": one line per Y, the nearest X on the map. */
  private async runNearestPerReference(compiled: CompiledNearest) {
    const [pairs, total] = await Promise.all([
      this.compiler.runNearestPerReference(compiled),
      this.compiler.referenceCount(compiled),
    ]);
    const layer = compiled.target.name;
    const refs = new Set(pairs.map((p) => String(p.refId))).size;
    const scope = total > refs ? `the first ${fmt(refs)} of ${fmt(total)}` : fmt(refs);
    const name = (label: string | null, id: number | string) => label ?? `#${id}`;
    const lines = pairs.map((p) => `${name(p.refLabel, p.refId)} → ${name(p.label, p.id)} (${fmtDist(p.distanceM)})`);
    const answer = pairs.length
      ? `Nearest ${layer} to each of ${scope} ${compiled.reference.name} feature${refs === 1 ? '' : 's'}` +
        (total > refs ? ' (add a condition to narrow them)' : '') + ': ' +
        lines.slice(0, 10).join('; ') + (lines.length > 10 ? `; … (${fmt(lines.length - 10)} more in the list).` : '.')
      : `No ${layer} features match, so none could be paired.`;
    const targetIds = [...new Map(pairs.map((p) => [String(p.id), p.id])).values()];
    const geometries = [...new Map(pairs.map((p) => [String(p.id), p.geometry])).values()].filter((g): g is Geo => g !== null);
    const result: GisChatSelection = {
      layerId: compiled.target.layerId,
      layerCode: compiled.target.code,
      layerName: layer,
      geometryType: compiled.target.geometryType,
      matched: targetIds.length,
      truncated: false,
      cql: this.compiler.buildCql(compiled.target, targetIds),
      geometries,
    };
    return {
      compiledSql: compiled.sql,
      compiledSummary: compiled.summary,
      result,
      answer,
      facts: { operation: 'nearest_each', layer, pairs: pairs.length },
      nearest: {
        referenceLayer: compiled.reference.name,
        referenceLabel: null,
        referenceCount: refs,
        items: pairs.map((p) => ({
          id: p.id,
          label: `${name(p.refLabel, p.refId)} → ${name(p.label, p.id)}`,
          distanceM: p.distanceM,
        })),
      },
      overlays: pairs.map((p) => p.refGeometry).filter((g): g is Geo => g !== null).slice(0, 450),
    };
  }

  private async runBuffer(op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    const compiled = this.compiler.compileBuffer(op, catalogEntries, ws);
    const buffer = await this.compiler.runBuffer(compiled);
    const { result } = await this.selection(op, catalogEntries, ws);
    const layer = compiled.target.name;
    const answer = buffer.sources
      ? `A ${fmtDist(compiled.distanceM)} buffer around ${fmt(buffer.sources)} ${layer} feature${buffer.sources === 1 ? '' : 's'} covers ${fmtArea(buffer.areaM2 ?? 0)}.`
      : `No ${layer} features match, so there is nothing to buffer.`;
    return {
      compiledSql: compiled.sql,
      compiledSummary: compiled.summary,
      result,
      answer,
      facts: {
        operation: 'buffer',
        layer,
        distance: fmtDist(compiled.distanceM),
        features: buffer.sources,
        area: buffer.areaM2 == null ? null : fmtArea(buffer.areaM2),
      },
      buffer: { distanceM: compiled.distanceM, sources: buffer.sources, areaM2: buffer.areaM2 },
      overlays: buffer.geometry ? [buffer.geometry] : [],
    };
  }

  private async runRoute(appUser: AppUser, op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    if (!op.to_layer) {
      throw new PlanValidationError('Route to where? Name the destination.');
    }
    const networkLayer = this.compiler.resolveNetwork(catalogEntries, op.network_layer);
    const from = await this.compiler.resolvePoint(catalogEntries, op.target_layer, op.attribute_filters, ws);
    const to = await this.compiler.resolvePoint(catalogEntries, op.to_layer, op.to_filters, ws);
    const route = await this.network.route(appUser, {
      layerId: networkLayer.layerId,
      from: [from.lon, from.lat],
      to: [to.lon, to.lat],
    });
    const note = (p: typeof from, end: string) =>
      p.matches > 1 ? ` ${fmt(p.matches)} features matched the ${end}; the first was used.` : '';
    const answer =
      (route.lengthM < 1
        ? `"${from.label}" (${from.layer.name}) and "${to.label}" (${to.layer.name}) meet ${networkLayer.name} at the same point, so there is no route between them to measure.`
        : `The shortest route along ${networkLayer.name} from "${from.label}" (${from.layer.name}) ` +
          `to "${to.label}" (${to.layer.name}) is ${fmtDist(route.lengthM)}.`) +
      note(from, 'start') + note(to, 'destination');
    const endpoints: Geo = {
      type: 'MultiPoint',
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
    };
    return {
      compiledSummary: `Shortest path on ${networkLayer.name}.`,
      answer,
      facts: {
        operation: 'route',
        from: from.label,
        to: to.label,
        network: networkLayer.name,
        length: fmtDist(route.lengthM),
      },
      route: {
        networkLayer: networkLayer.name,
        from: { label: from.label, layer: from.layer.name, matches: from.matches },
        to: { label: to.label, layer: to.layer.name, matches: to.matches },
        lengthM: route.lengthM,
      },
      overlays: [route.path as unknown as Geo, endpoints],
    };
  }

  private async runServiceArea(appUser: AppUser, op: AiGisOperation, catalogEntries: Catalog, ws: string) {
    const d = Number(op.distance_meters);
    if (!Number.isFinite(d) || d <= 0) {
      throw new PlanValidationError('How far along the roads? Give a distance in metres.');
    }
    const networkLayer = this.compiler.resolveNetwork(catalogEntries, op.network_layer);
    const origin = await this.compiler.resolvePoint(catalogEntries, op.target_layer, op.attribute_filters, ws);
    const response = await this.network.serviceArea(appUser, {
      layerId: networkLayer.layerId,
      at: [origin.lon, origin.lat],
      breaks: [d],
    });
    const area = response.areas[0];
    const answer =
      `Within ${fmtDist(d)} by road from "${origin.label}" (${origin.layer.name}), ` +
      `${fmtDist(area?.lengthM ?? 0)} of ${networkLayer.name} can be reached.` +
      (origin.matches > 1 ? ` ${fmt(origin.matches)} features matched the start; the first was used.` : '');
    const overlays = [
      area?.area as Geo | null,
      { type: 'Point', coordinates: [origin.lon, origin.lat] } as Geo,
    ].filter((g): g is Geo => !!g);
    return {
      compiledSummary: `Service area on ${networkLayer.name}.`,
      answer,
      facts: {
        operation: 'service_area',
        from: origin.label,
        network: networkLayer.name,
        distance: fmtDist(d),
        reachableRoads: fmtDist(area?.lengthM ?? 0),
      },
      serviceArea: {
        networkLayer: networkLayer.name,
        origin: { label: origin.label, layer: origin.layer.name, matches: origin.matches },
        distanceM: d,
        roadLengthM: area?.lengthM ?? 0,
      },
      overlays,
    };
  }
}

/** The layer's real fields as choices: same kind of data as the unknown
 *  field's value first, each with sample values, each a ready-to-run plan
 *  with the field swapped in. */
function fieldChoices(operation: AiGisOperation, error: UnknownFieldError): AiClarifyOption[] {
  const bad = error.field;
  const filter = [
    ...(operation.attribute_filters ?? []),
    ...(operation.spatial_filter?.reference_filters ?? []),
  ].find((f) => f.field === bad);
  const value = filter?.value ?? filter?.values?.[0];
  const wantText = typeof value === 'string' && Number.isNaN(Number(value));
  const columns = error.layer.columns.filter(
    (c) =>
      c.kind !== 'geometry' &&
      c.kind !== 'id' &&
      c.role !== 'hidden' &&
      c.role !== 'id' &&
      !/(^|_)(gis_remark|gen_id|objectid)$/i.test(c.name),
  );
  const ranked = [...columns].sort((a, b) => {
    const kind = (c: typeof a) => (wantText ? (c.kind === 'text' ? 0 : 1) : c.kind === 'text' ? 1 : 0);
    return kind(a) - kind(b) || similarity(bad, b.name) - similarity(bad, a.name);
  });
  return ranked.slice(0, 5).map((c) => ({
    label: c.sampleValues.length
      ? `${c.name} — e.g. ${c.sampleValues.filter((v) => v !== '…(more)').slice(0, 3).join(', ')}`
      : c.name,
    operation: {
      ...swapField(operation, bad, c.name),
      learn_alias: { layer_id: error.layer.layerId, field: c.name, alias: bad.replace(/_/g, ' ') },
    },
  }));
}

function distanceChoices(operation: AiGisOperation): AiClarifyOption[] {
  return [50, 100, 250, 500].map((d) => ({
    label: `${d} m`,
    operation: {
      ...operation,
      spatial_filter: operation.spatial_filter ? { ...operation.spatial_filter, distance_meters: d } : null,
    },
  }));
}

function swapField(operation: AiGisOperation, from: string, to: string): AiGisOperation {
  const op = JSON.parse(JSON.stringify(operation)) as AiGisOperation;
  const swap = (f: { field: string }) => {
    if (f.field === from) f.field = to;
  };
  (op.attribute_filters ?? []).forEach(swap);
  (op.reference_filters ?? []).forEach(swap);
  (op.to_filters ?? []).forEach(swap);
  (op.spatial_filter?.reference_filters ?? []).forEach(swap);
  for (const key of ['metric_field', 'group_by', 'group_by_layer_field', 'order_by'] as const) {
    if (op[key] === from) op[key] = to;
  }
  return op;
}

/** Shared-letter-pair similarity of two names, 0..1 ("material" ~ "constructi" is low, "dia" ~ "pipe_dia_i" high). */
function similarity(a: string, b: string): number {
  const pairs = (s: string) => {
    const t = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const pa = pairs(a);
  const pb = pairs(b);
  let shared = 0;
  for (const p of pa) if (pb.has(p)) shared++;
  return pa.size + pb.size ? (2 * shared) / (pa.size + pb.size) : 0;
}

/** The answer as stored for reopening a chat: no geometries / overlays
 *  (they can be large and are re-derived from the plan on demand). */
function stripForStorage(response: GisChatResponse): Prisma.InputJsonValue {
  const copy = { ...response } as Record<string, unknown>;
  delete copy['overlays'];
  if (response.result) copy['result'] = { ...response.result, geometries: [] };
  return JSON.parse(JSON.stringify(copy)) as Prisma.InputJsonValue;
}

/** A raw query row made JSON-safe: bigint -> number, Date -> ISO text. */
function plainRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === 'bigint' ? Number(v) : v instanceof Date ? v.toISOString() : v;
  }
  return out;
}
