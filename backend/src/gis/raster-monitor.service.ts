import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Prisma, RasterMonitor } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { ModuleAccessService } from '../module-access/module-access.service';
import { RasterJobsService } from './raster-jobs.service';
import { RasterMailService } from './raster-mail.service';
import { AiClientService } from '../gis-ai/ai-client.service';
import { RASTER_MODULES } from './raster-tool-registry';

export type MonitorKind = 'green-cover' | 'encroachment';
export type MonitorFrequency = 'weekly' | 'monthly';

const KIND_MODULE: Record<MonitorKind, number> = {
  'green-cover': RASTER_MODULES.greenCover,
  encroachment: RASTER_MODULES.encroachment,
};

/** How often the scheduler looks for due monitors. */
const TICK_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (now: Date, days: number) => new Date(now.getTime() - days * DAY_MS);

/**
 * Raster Analysis → Automatic Monitoring. A monitor re-runs Green Cover or
 * Encroachment for the same zones every week / month, always comparing the
 * last 60 days with the same 60 days a year earlier (season-matched, so
 * monsoon greening is not reported as change). The run goes through the
 * normal job queue as the monitor's creator — with their current
 * permissions — and its summary and alert are stored on the monitor.
 */
@Injectable()
export class RasterMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RasterMonitorService.name);
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: RasterJobsService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly mail: RasterMailService,
    private readonly ai: AiClientService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test' || process.env.RASTER_MONITOR_SCHEDULER === '0') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    setTimeout(() => void this.tick(), 60 * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ----- API -----

  /** The owner sees every monitor of the municipality; others their own. */
  list(appUser: AppUser) {
    return this.prisma.rasterMonitor.findMany({
      where: {
        municipalityId: appUser.municipalityId,
        ...(appUser.systemRole === 'MUNICIPALITY_OWNER' ? {} : { createdById: appUser.id }),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(
    appUser: AppUser,
    dto: { name: string; kind: MonitorKind; frequency: MonitorFrequency; params: Record<string, unknown> },
  ) {
    const granted = await this.moduleAccess.getEffectiveModuleIdsForAppUser(appUser);
    if (!granted.has(KIND_MODULE[dto.kind])) {
      throw new ForbiddenException('Your module access does not include this tool.');
    }
    const params = this.cleanParams(dto.kind, dto.params);
    // Same validation the scheduled run will face, with sample dates.
    await this.jobs.validateBody(dto.kind, this.body(dto.kind, params, new Date()));
    return this.prisma.rasterMonitor.create({
      data: {
        municipalityId: appUser.municipalityId,
        createdById: appUser.id,
        name: dto.name.trim(),
        kind: dto.kind,
        frequency: dto.frequency,
        params: params as Prisma.InputJsonValue,
        nextRunAt: new Date(),
      },
    });
  }

  async remove(appUser: AppUser, id: string): Promise<void> {
    await this.owned(appUser, id);
    await this.prisma.rasterMonitor.delete({ where: { id } });
  }

  async setActive(appUser: AppUser, id: string, active: boolean) {
    await this.owned(appUser, id);
    return this.prisma.rasterMonitor.update({
      where: { id },
      data: { active, ...(active ? { nextRunAt: new Date() } : {}) },
    });
  }

  async acknowledge(appUser: AppUser, id: string) {
    await this.owned(appUser, id);
    return this.prisma.rasterMonitor.update({ where: { id }, data: { alert: false } });
  }

  async runNow(appUser: AppUser, id: string) {
    const monitor = await this.owned(appUser, id);
    await this.run(monitor);
    return this.prisma.rasterMonitor.findUniqueOrThrow({ where: { id } });
  }

  // ----- scheduler -----

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const due = await this.prisma.rasterMonitor.findMany({
        where: { active: true, nextRunAt: { lte: new Date() }, NOT: { lastStatus: 'running' } },
        take: 10,
      });
      for (const monitor of due) await this.run(monitor);
    } catch (error) {
      this.logger.error(`Monitor tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async run(monitor: RasterMonitor): Promise<void> {
    const now = new Date();
    const next = new Date(now.getTime() + (monitor.frequency === 'weekly' ? 7 : 30) * DAY_MS);
    const user = await this.prisma.user.findUnique({ where: { id: monitor.createdById } });
    if (!user || user.status !== 'ACTIVE') {
      await this.prisma.rasterMonitor.update({
        where: { id: monitor.id },
        data: { active: false, lastStatus: 'failed', lastSummary: 'Paused — the creator account is no longer active.' },
      });
      return;
    }
    const appUser: AppUser = {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      municipalityId: user.municipalityId,
      departmentId: user.departmentId,
      systemRole: user.systemRole,
      status: user.status,
    };
    const kind = monitor.kind as MonitorKind;
    await this.prisma.rasterMonitor.update({
      where: { id: monitor.id },
      data: { lastStatus: 'running', lastRunAt: now, nextRunAt: next },
    });
    try {
      await this.jobs.start(appUser, kind, this.body(kind, monitor.params as Record<string, unknown>, now), undefined, (job) =>
        void this.finished(monitor, job.status, job.result, job.error),
      );
    } catch (error) {
      await this.finished(monitor, 'failed', null, (error as Error).message);
    }
  }

  private async finished(monitor: RasterMonitor, status: string, result: unknown, error: string | null) {
    const data: Prisma.RasterMonitorUpdateInput = { lastStatus: status === 'done' ? 'done' : 'failed' };
    if (status !== 'done') {
      data.lastSummary = error ?? 'The run was cancelled.';
    } else {
      const r = ((result as { result?: unknown })?.result ?? {}) as Record<string, unknown>;
      const rule = (monitor.params as Record<string, unknown>).alertDropPct;
      const { summary, alert } = this.evaluate(monitor.kind as MonitorKind, r, typeof rule === 'number' ? rule : 2);
      data.lastSummary = summary;
      data.lastResult = r as Prisma.InputJsonValue;
      if (alert) {
        data.alert = true;
        data.alertMessage = `${new Date().toISOString().slice(0, 10)}: ${summary}`;
        void this.email(monitor, summary, r);
      }
    }
    await this.prisma.rasterMonitor.update({ where: { id: monitor.id }, data }).catch(() => undefined);
  }

  /** The alert rules: any new built-up site, or a zone losing more than
   *  `dropPct` points of green cover year-on-year. */
  private evaluate(kind: MonitorKind, r: Record<string, unknown>, dropPct: number) {
    if (kind === 'encroachment') {
      const count = Number(r.count ?? 0);
      const ha = Number(r.newBuiltM2 ?? 0) / 1e4;
      return {
        alert: count > 0,
        summary: count > 0
          ? `${count} new built-up site${count === 1 ? '' : 's'} (${ha.toFixed(2)} ha) in the protected zones.`
          : 'No new built-up land in the protected zones.',
      };
    }
    const rows = (r.rows as { zone: string; changePct?: number }[] | undefined) ?? [];
    const losing = rows.filter((z) => (z.changePct ?? 0) <= -dropPct).sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0));
    const overall = Number(r.overallGreenPct ?? 0).toFixed(1);
    return {
      alert: losing.length > 0,
      summary: losing.length
        ? `${losing.length} zone${losing.length === 1 ? '' : 's'} lost ≥ ${dropPct} points of green cover (worst: ${losing[0].zone}, ${losing[0].changePct?.toFixed(1)}). Overall ${overall} % green.`
        : `Green cover stable — overall ${overall} % green.`,
    };
  }

  /** Alert email to the monitor's creator (best effort), with a plain-
   *  language AI explanation when the local model is up. */
  private async email(monitor: RasterMonitor, summary: string, result: Record<string, unknown>): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: monitor.createdById } });
    if (!user?.email) return;
    const explanation = await this.explain(monitor, summary, result);
    const sent = await this.mail.send(
      user.email,
      `GIS alert: ${monitor.name}`,
      [
        `Hello ${user.fullName},`,
        '',
        `Your Raster Analysis monitor "${monitor.name}" found a change:`,
        '',
        `  ${summary}`,
        '',
        ...(explanation ? ['In plain words (AI summary of the numbers above):', '', `  ${explanation}`, ''] : []),
        `Open the map → Raster Analysis → Planning → Automatic Monitoring to review it:`,
        `${this.mail.appUrl}/gis`,
        '',
        '— Municipal GIS Platform',
      ].join('\n'),
    );
    if (sent) this.logger.log(`Alert email for monitor ${monitor.id} sent to ${user.email}`);
  }

  /** Null when the AI service is down, slow, or its text strays from the
   *  numbers — the email then goes out with the rule-based summary only. */
  private async explain(monitor: RasterMonitor, summary: string, result: Record<string, unknown>): Promise<string | null> {
    const rows = Array.isArray(result.rows) ? (result.rows as unknown[]).slice(0, 20) : undefined;
    const { rows: _rows, ...scalars } = result;
    try {
      const out = await this.ai.narrate(
        {
          kind: 'raster',
          question: `Explain this ${monitor.kind === 'encroachment' ? 'encroachment (new construction)' : 'green cover'} monitoring alert in plain language.`,
          facts: {
            monitor: monitor.name,
            alert: summary,
            comparison: 'last 60 days vs the same 60 days a year earlier',
            results: Object.fromEntries(Object.entries(scalars).filter(([, v]) => typeof v !== 'object')),
            ...(rows ? { zones: rows } : {}),
          },
        },
        120000,
      );
      return out.grounded && out.text.trim() ? out.text.trim() : null;
    } catch {
      return null;
    }
  }

  // ----- helpers -----

  /** Last 60 days vs. the same 60 days a year earlier. */
  private body(kind: MonitorKind, params: Record<string, unknown>, now: Date): Record<string, unknown> {
    const { alertDropPct: _rule, ...rest } = params;
    const after = { from: iso(daysAgo(now, 60)), to: iso(now) };
    const before = { from: iso(daysAgo(now, 425)), to: iso(daysAgo(now, 365)) };
    return kind === 'green-cover'
      ? { ...rest, from: after.from, to: after.to, compareFrom: before.from, compareTo: before.to }
      : { ...rest, beforeFrom: before.from, beforeTo: before.to, afterFrom: after.from, afterTo: after.to };
  }

  private cleanParams(kind: MonitorKind, params: Record<string, unknown>): Record<string, unknown> {
    if (!params || typeof params !== 'object') throw new BadRequestException('Missing monitor settings.');
    const allowed = ['zonesLayerId', 'labelField', 'filterField', 'filterValue', 'alertDropPct',
      ...(kind === 'green-cover' ? ['threshold'] : ['minAreaM2', 'sensitivity'])];
    return Object.fromEntries(Object.entries(params).filter(([k, v]) => allowed.includes(k) && v !== undefined && v !== null && v !== ''));
  }

  private async owned(appUser: AppUser, id: string): Promise<RasterMonitor> {
    const monitor = await this.prisma.rasterMonitor.findUnique({ where: { id } });
    const visible =
      monitor &&
      monitor.municipalityId === appUser.municipalityId &&
      (appUser.systemRole === 'MUNICIPALITY_OWNER' || monitor.createdById === appUser.id);
    if (!visible) throw new NotFoundException('Monitor not found.');
    return monitor;
  }
}
