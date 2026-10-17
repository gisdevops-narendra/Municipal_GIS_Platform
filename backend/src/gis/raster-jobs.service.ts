import {
  BadRequestException,
  OnModuleInit,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import type { AppUser } from '../auth/types/app-user.type';
import { RasterToolsService } from './raster-tools.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { RASTER_JOB_TOOLS } from './raster-tool-registry';
import { rasterJobContext, type RasterJobContext } from './raster-job-context';

export type RasterJobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';



interface RasterJob {
  id: string;
  tool: string;
  userId: string;
  municipalityId: string;
  status: RasterJobStatus;
  stage: string;
  cancellable: boolean;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  result: unknown;
  error: string | null;
  abort: AbortController;
  body: unknown;
  onFinish?: (job: ReturnType<RasterJobsService['view']>) => void;
  start: () => void;
}

/** Concurrent GDAL processes for the whole backend / one user. */
const MAX_RUNNING = 3;
const MAX_ACTIVE_PER_USER = 4;
/** Finished jobs are kept this long for the panel to collect. */
const KEEP_FINISHED_MS = 60 * 60 * 1000;

/**
 * Raster Analysis background jobs. A tool that publishes a layer can take
 * minutes, longer than a proxy or browser keeps one HTTP request open, so
 * the panel starts a job, polls its status and may cancel it. Jobs live in
 * memory: a backend restart drops them (the panel reports that as failed).
 */
@Injectable()
export class RasterJobsService implements OnModuleInit {
  private readonly logger = new Logger(RasterJobsService.name);
  private readonly jobs = new Map<string, RasterJob>();
  private readonly queue: RasterJob[] = [];
  private running = 0;

  constructor(
    private readonly tools: RasterToolsService,
    private readonly prisma: PrismaService,
  ) {}

  /** Validates a tool body without running it (e.g. a monitor's settings). */
  async validateBody(tool: string, body: unknown): Promise<void> {
    const def = RASTER_JOB_TOOLS[tool];
    if (!def) throw new NotFoundException(`Unknown raster tool "${tool}".`);
    const errors = await validate(plainToInstance(def.dto, body ?? {}), { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      throw new BadRequestException(messages.length ? messages : 'Invalid request.');
    }
  }

  /** `onFinish`: called once with the final job view (done / failed / cancelled). */
  async start(
    appUser: AppUser,
    tool: string,
    body: unknown,
    outputDepartmentId?: string,
    onFinish?: (job: ReturnType<RasterJobsService['view']>) => void,
    resumeId?: string,
  ) {
    const def = RASTER_JOB_TOOLS[tool];
    if (!def) throw new NotFoundException(`Unknown raster tool "${tool}".`);
    const dto = plainToInstance(def.dto, body ?? {});
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length) {
      const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
      throw new BadRequestException(messages.length ? messages : 'Invalid request.');
    }
    this.prune();
    const active = [...this.jobs.values()].filter(
      (j) => j.userId === appUser.id && (j.status === 'queued' || j.status === 'running'),
    ).length;
    if (active >= MAX_ACTIVE_PER_USER) {
      throw new ConflictException(`You already have ${active} raster jobs running — wait for one to finish.`);
    }

    const job: RasterJob = {
      id: resumeId ?? randomUUID(),
      tool,
      userId: appUser.id,
      municipalityId: appUser.municipalityId,
      status: 'queued',
      stage: 'Waiting for a free processing slot',
      cancellable: true,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      abort: new AbortController(),
      body,
      onFinish,
      start: () => void this.execute(job, () => def.run(this.tools, appUser, dto as never), body, outputDepartmentId),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    void this.persist(job, outputDepartmentId);
    this.drain();
    return this.view(job);
  }

  /** A custom task (e.g. a saved workflow) through the same queue,
   *  limits, stages and cancel as a tool job. */
  startTask(appUser: AppUser, tool: string, body: unknown, run: () => Promise<unknown>) {
    this.prune();
    const job: RasterJob = {
      id: randomUUID(),
      tool,
      userId: appUser.id,
      municipalityId: appUser.municipalityId,
      status: 'queued',
      stage: 'Waiting for a free processing slot',
      cancellable: true,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
      result: null,
      error: null,
      abort: new AbortController(),
      body,
      start: () => void this.execute(job, run, body),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    void this.persist(job);
    this.drain();
    return this.view(job);
  }

  get(appUser: AppUser, id: string) {
    return this.view(this.owned(appUser, id));
  }

  /** Like `get`, but a job no longer in memory (pruned, or lost before a
   *  restart finished) is answered from Job History. */
  async getOrRecord(appUser: AppUser, id: string) {
    if (this.jobs.get(id)?.userId === appUser.id) return this.get(appUser, id);
    const row = await this.prisma.rasterJobHistory.findUnique({ where: { id } });
    if (!row || row.userId !== appUser.id) throw new NotFoundException('Job not found.');
    const layer = row.layerId ? await this.prisma.gISLayer.findUnique({ where: { id: row.layerId } }) : null;
    return {
      id: row.id, tool: row.tool, status: row.status as RasterJobStatus, stage: row.status,
      cancellable: false, queuePosition: null, createdAt: row.createdAt, elapsedMs: 0,
      result: layer ? { layer, result: {} } : null,
      error: row.status === 'failed' ? row.summary : null,
    };
  }

  list(appUser: AppUser) {
    this.prune();
    return [...this.jobs.values()]
      .filter((j) => j.userId === appUser.id)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, 20)
      .map((j) => this.view(j));
  }

  cancel(appUser: AppUser, id: string) {
    const job = this.owned(appUser, id);
    if (job.status === 'queued') {
      this.queue.splice(this.queue.indexOf(job), 1);
      this.finish(job, 'cancelled', null, null);
    } else if (job.status === 'running') {
      if (!job.cancellable) {
        throw new ConflictException('The result is already being published — it can no longer be cancelled.');
      }
      job.abort.abort();
      job.stage = 'Cancelling…';
    }
    return this.view(job);
  }

  // ----- internals -----

  private drain(): void {
    while (this.running < MAX_RUNNING && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      job.status = 'running';
      job.startedAt = new Date();
      void this.prisma.rasterJobHistory.update({ where: { id: job.id }, data: { status: 'running' } }).catch(() => undefined);
      job.stage = 'Starting';
      job.start();
    }
  }

  private async execute(
    job: RasterJob,
    run: () => Promise<unknown>,
    body?: unknown,
    outputDepartmentId?: string,
  ): Promise<void> {
    const context: RasterJobContext = {
      signal: job.abort.signal,
      setStage: (stage, cancellable = true) => {
        job.stage = stage;
        job.cancellable = cancellable;
      },
      outputDepartmentId,
      sources: [],
      describe: () => provenance(job.tool, body, context.sources),
    };
    try {
      const result = await rasterJobContext.run(context, run);
      if (job.abort.signal.aborted) this.finish(job, 'cancelled', null, null);
      else this.finish(job, 'done', result, null);
    } catch (error) {
      if (job.abort.signal.aborted) {
        this.finish(job, 'cancelled', null, null);
      } else {
        const message =
          error instanceof HttpException ? this.httpMessage(error) : 'Raster processing failed.';
        if (!(error instanceof HttpException)) this.logger.error(`Raster job ${job.tool} failed: ${(error as Error).stack}`);
        this.finish(job, 'failed', null, message);
      }
    } finally {
      this.running--;
      this.drain();
    }
  }

  private finish(job: RasterJob, status: RasterJobStatus, result: unknown, error: string | null): void {
    job.status = status;
    job.result = result;
    job.error = error;
    job.finishedAt = new Date();
    job.stage = status === 'done' ? 'Finished' : status === 'cancelled' ? 'Cancelled' : 'Failed';
    job.cancellable = false;
    void this.record(job);
    try {
      job.onFinish?.(this.view(job));
    } catch (e) {
      this.logger.warn(`Job ${job.id} finish hook failed: ${(e as Error).message}`);
    }
  }

  /** Job History: every finished job, with its body for "run again". */
  private async record(job: RasterJob): Promise<void> {
    const layer = (job.result as { layer?: { id?: string; name?: string } } | null)?.layer;
    const summary =
      job.status === 'failed' ? job.error : job.status === 'cancelled' ? 'Cancelled' : layer?.name ? `Created "${layer.name}"` : 'Finished';
    const data = {
      status: job.status,
      summary: summary?.slice(0, 500) ?? null,
      layerId: layer?.id ?? null,
      layerName: layer?.name ?? null,
      finishedAt: job.finishedAt ?? new Date(),
    };
    await this.prisma.rasterJobHistory
      .upsert({
        where: { id: job.id },
        update: data,
        create: {
          id: job.id,
          municipalityId: job.municipalityId,
          userId: job.userId,
          tool: job.tool,
          body: (job.body ?? {}) as Prisma.InputJsonValue,
          status: job.status,
          summary: summary?.slice(0, 500) ?? null,
          layerId: layer?.id ?? null,
          layerName: layer?.name ?? null,
          createdAt: job.createdAt,
          finishedAt: job.finishedAt ?? new Date(),
        },
      })
      .catch((e: Error) => this.logger.warn(`Job ${job.id} not recorded in history: ${e.message}`));
  }

  /** Saved as soon as it is queued, so a restart can resume it. */
  private async persist(job: RasterJob, outputDepartmentId?: string): Promise<void> {
    await this.prisma.rasterJobHistory
      .create({
        data: {
          id: job.id,
          municipalityId: job.municipalityId,
          userId: job.userId,
          tool: job.tool,
          body: (job.body ?? {}) as Prisma.InputJsonValue,
          status: 'queued',
          outputDepartmentId: outputDepartmentId ?? null,
          createdAt: job.createdAt,
        },
      })
      .catch((e: Error) => this.logger.warn(`Job ${job.id} not persisted: ${e.message}`));
  }

  /** After a restart: re-queue tool jobs that were queued or running (same
   *  id, so an open panel keeps polling); a workflow cannot be resumed
   *  mid-chain and is marked failed. Disabled with RASTER_JOBS_RESUME=0
   *  (e.g. for scripts that boot a second application context). */
  async onModuleInit(): Promise<void> {
    if (process.env.RASTER_JOBS_RESUME === '0' || process.env.NODE_ENV === 'test') return;
    const unfinished = await this.prisma.rasterJobHistory
      .findMany({ where: { status: { in: ['queued', 'running'] } }, orderBy: { createdAt: 'asc' } })
      .catch(() => []);
    for (const row of unfinished) {
      const user = await this.prisma.user.findUnique({ where: { id: row.userId } });
      if (!RASTER_JOB_TOOLS[row.tool] || !user || user.status !== 'ACTIVE') {
        await this.prisma.rasterJobHistory.update({
          where: { id: row.id },
          data: { status: 'failed', summary: 'Interrupted by a server restart — please run it again.', finishedAt: new Date() },
        });
        continue;
      }
      const appUser: AppUser = {
        id: user.id, keycloakUserId: user.keycloakUserId, municipalityId: user.municipalityId,
        departmentId: user.departmentId, systemRole: user.systemRole, status: user.status,
      };
      try {
        await this.prisma.rasterJobHistory.delete({ where: { id: row.id } });
        await this.start(appUser, row.tool, row.body, row.outputDepartmentId ?? undefined, undefined, row.id);
        this.logger.log(`Resumed raster job ${row.id} (${row.tool}) after restart`);
      } catch (e) {
        this.logger.warn(`Could not resume raster job ${row.id}: ${(e as Error).message}`);
      }
    }
  }

  /** Stores the results-screen report on the job that produced `layerId`
   *  (the user who ran it, or the Owner). */
  async saveReport(appUser: AppUser, layerId: string, report: Record<string, unknown>) {
    const row = await this.prisma.rasterJobHistory.findFirst({
      where: {
        layerId,
        municipalityId: appUser.municipalityId,
        ...(appUser.systemRole === 'MUNICIPALITY_OWNER' ? {} : { userId: appUser.id }),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new NotFoundException('No analysis job produced this layer.');
    await this.prisma.rasterJobHistory.update({
      where: { id: row.id },
      data: { report: report as Prisma.InputJsonValue },
    });
    return { saved: true };
  }

  /** The latest saved report for a layer (caller has already been checked
   *  for VIEW access on the layer). */
  async getReport(appUser: AppUser, layerId: string) {
    const row = await this.prisma.rasterJobHistory.findFirst({
      where: { layerId, municipalityId: appUser.municipalityId, report: { not: Prisma.DbNull } },
      orderBy: { createdAt: 'desc' },
      select: { report: true, tool: true, createdAt: true, layerName: true },
    });
    return row ?? { report: null };
  }

  history(appUser: AppUser) {
    return this.prisma.rasterJobHistory.findMany({
      where: { userId: appUser.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private httpMessage(error: HttpException): string {
    const body = error.getResponse() as string | { message?: string | string[] };
    if (typeof body === 'string') return body;
    return Array.isArray(body.message) ? body.message.join(' ') : (body.message ?? error.message);
  }

  private owned(appUser: AppUser, id: string): RasterJob {
    const job = this.jobs.get(id);
    if (!job || job.userId !== appUser.id) throw new NotFoundException('Job not found.');
    return job;
  }

  private prune(): void {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.jobs) {
      if (job.finishedAt && job.finishedAt.getTime() < cutoff) this.jobs.delete(id);
    }
  }

  view(job: RasterJob) {
    const now = job.finishedAt ?? new Date();
    return {
      id: job.id,
      tool: job.tool,
      status: job.status,
      stage: job.stage,
      cancellable: job.cancellable,
      queuePosition: job.status === 'queued' ? this.queue.indexOf(job) + 1 : null,
      createdAt: job.createdAt,
      elapsedMs: job.startedAt ? now.getTime() - job.startedAt.getTime() : 0,
      result: job.result,
      error: job.error,
    };
  }
}

/** Keys too large or too technical for a layer description. */
const SKIP_PARAMS = new Set(['polygon', 'bbox', 'outputName', 'classes', 'rules', 'inputs', 'points', 'line', 'layerIds']);

/** "Raster Analysis · slope from "DEM" (2026-10-16) · percent: true" —
 *  stored as the new layer's description so its origin is never lost. */
function provenance(tool: string, body: unknown, sources: string[]): string {
  const params = Object.entries((body ?? {}) as Record<string, unknown>)
    .filter(([key, value]) => !SKIP_PARAMS.has(key) && !/Id$/.test(key) && value !== undefined && value !== null && typeof value !== 'object')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .slice(0, 8);
  const from = sources.length ? ` from ${[...new Set(sources)].map((s) => `"${s}"`).join(', ')}` : '';
  const text = `Raster Analysis · ${tool}${from} (${new Date().toISOString().slice(0, 10)})${params.length ? ' · ' + params.join(', ') : ''}`;
  return text.slice(0, 500);
}
