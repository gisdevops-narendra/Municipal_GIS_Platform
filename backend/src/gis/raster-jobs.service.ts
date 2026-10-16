import {
  BadRequestException,
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
export class RasterJobsService {
  private readonly logger = new Logger(RasterJobsService.name);
  private readonly jobs = new Map<string, RasterJob>();
  private readonly queue: RasterJob[] = [];
  private running = 0;

  constructor(private readonly tools: RasterToolsService) {}

  async start(appUser: AppUser, tool: string, body: unknown) {
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
      start: () => void this.execute(job, () => def.run(this.tools, appUser, dto as never)),
    };
    this.jobs.set(job.id, job);
    this.queue.push(job);
    this.drain();
    return this.view(job);
  }

  get(appUser: AppUser, id: string) {
    return this.view(this.owned(appUser, id));
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
      job.stage = 'Starting';
      job.start();
    }
  }

  private async execute(job: RasterJob, run: () => Promise<unknown>): Promise<void> {
    const context: RasterJobContext = {
      signal: job.abort.signal,
      setStage: (stage, cancellable = true) => {
        job.stage = stage;
        job.cancellable = cancellable;
      },
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

  private view(job: RasterJob) {
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
