import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import { ModuleAccessService } from '../module-access/module-access.service';
import { RasterJobsService } from './raster-jobs.service';
import { rasterJobContext } from './raster-job-context';
import { RasterToolsService } from './raster-tools.service';
import { RASTER_JOB_TOOLS } from './raster-tool-registry';

export interface WorkflowStep {
  tool: string;
  body: Record<string, unknown>;
}

/** Placeholders a workflow step's body may use for its input layer. */
const PREV = '$prev';
const INPUT = '$input';

/**
 * Raster Analysis workspace tools: saved workflows (tool chains), storage
 * management and dashboard pins.
 */
@Injectable()
export class RasterWorkspaceService {
  private readonly logger = new Logger(RasterWorkspaceService.name);
  private readonly storageRoot: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: RasterJobsService,
    private readonly tools: RasterToolsService,
    private readonly moduleAccess: ModuleAccessService,
    config: ConfigService,
  ) {
    this.storageRoot = path.resolve(config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'));
  }

  // ----- Saved Workflows -----

  listWorkflows(appUser: AppUser) {
    return this.prisma.rasterWorkflow.findMany({
      where: { municipalityId: appUser.municipalityId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createWorkflow(appUser: AppUser, name: string, steps: WorkflowStep[]) {
    if (!steps.length) throw new BadRequestException('A workflow needs at least one step.');
    for (const step of steps) {
      if (!RASTER_JOB_TOOLS[step.tool]) throw new BadRequestException(`Unknown tool "${step.tool}".`);
    }
    return this.prisma.rasterWorkflow.create({
      data: {
        municipalityId: appUser.municipalityId,
        createdById: appUser.id,
        name: name.trim(),
        steps: steps as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async deleteWorkflow(appUser: AppUser, id: string): Promise<void> {
    const wf = await this.prisma.rasterWorkflow.findUnique({ where: { id } });
    if (!wf || wf.municipalityId !== appUser.municipalityId) throw new NotFoundException('Workflow not found.');
    if (wf.createdById !== appUser.id && appUser.systemRole !== 'MUNICIPALITY_OWNER') {
      throw new ForbiddenException('Only its creator or the owner can delete this workflow.');
    }
    await this.prisma.rasterWorkflow.delete({ where: { id } });
  }

  /** Runs the steps in order as one background job. "$input" is the raster
   *  chosen at run time, "$prev" the previous step's output layer. */
  async runWorkflow(appUser: AppUser, id: string, inputLayerId?: string) {
    const wf = await this.prisma.rasterWorkflow.findUnique({ where: { id } });
    if (!wf || wf.municipalityId !== appUser.municipalityId) throw new NotFoundException('Workflow not found.');
    const steps = wf.steps as unknown as WorkflowStep[];
    const granted = await this.moduleAccess.getEffectiveModuleIdsForAppUser(appUser);
    for (const step of steps) {
      const def = RASTER_JOB_TOOLS[step.tool];
      const ids = typeof def?.modules === 'function' ? def.modules(step.body) : def?.modules ?? [];
      if (!def || !ids.some((m) => granted.has(m))) {
        throw new ForbiddenException(`Your module access does not include step "${step.tool}".`);
      }
    }
    const usesInput = JSON.stringify(steps).includes(INPUT);
    if (usesInput && !inputLayerId) throw new BadRequestException('Choose the input raster for this workflow.');

    return this.jobs.startTask(appUser, `workflow: ${wf.name}`, { workflowId: wf.id, inputLayerId }, async () => {
      const outputs: { step: number; tool: string; layerId?: string; layerName?: string }[] = [];
      let prev: string | undefined = inputLayerId;
      for (const [i, step] of steps.entries()) {
        const job = rasterJobContext.getStore();
        job?.setStage(`Step ${i + 1} / ${steps.length}: ${step.tool}`);
        const body = substitute(step.body, { [INPUT]: inputLayerId, [PREV]: prev });
        const def = RASTER_JOB_TOOLS[step.tool];
        const dto = plainToInstance(def.dto, body);
        const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
        if (errors.length) {
          throw new BadRequestException(
            `Step ${i + 1} (${step.tool}): ${errors.flatMap((e) => Object.values(e.constraints ?? {})).join(' ')}`,
          );
        }
        const result = (await def.run(this.tools, appUser, dto as never)) as { layer?: { id: string; name: string } };
        outputs.push({ step: i + 1, tool: step.tool, layerId: result?.layer?.id, layerName: result?.layer?.name });
        if (result?.layer?.id) prev = result.layer.id;
      }
      const last = [...outputs].reverse().find((o) => o.layerId);
      return {
        layer: last ? await this.prisma.gISLayer.findUnique({ where: { id: last.layerId } }) : undefined,
        result: { steps: outputs },
      };
    });
  }

  // ----- Storage Manager -----

  /** Raster files, temp files and vector result tables, per department. */
  async storage(appUser: AppUser) {
    this.assertOwner(appUser);
    const dir = path.join(this.storageRoot, appUser.municipalityId, 'rasters');
    const files = await this.listFiles(dir);
    const tmp = await this.listFiles(path.join(dir, 'tmp'));
    const layers = await this.prisma.gISLayer.findMany({
      where: { gisWorkspace: { municipalityId: appUser.municipalityId }, rasterAnalysis: true },
      select: { id: true, name: true, layerType: true, postgisTable: true, departmentId: true, createdAt: true },
    });
    const departments = new Map(
      (await this.prisma.department.findMany({ where: { municipalityId: appUser.municipalityId }, select: { id: true, name: true } }))
        .map((d) => [d.id, d.name]),
    );
    const byId = new Map(layers.map((l) => [l.id, l]));
    const rows: { layerId: string | null; name: string; department: string; kind: string; bytes: number; createdAt: Date | null }[] = [];
    let orphanBytes = 0;
    for (const f of files) {
      const layer = byId.get(path.basename(f.name, '.tif'));
      if (!layer) {
        orphanBytes += f.size;
        continue;
      }
      rows.push({
        layerId: layer.id, name: layer.name, department: departments.get(layer.departmentId ?? '') ?? 'Municipality-wide',
        kind: 'Raster', bytes: f.size, createdAt: layer.createdAt,
      });
    }
    for (const l of layers.filter((x) => x.layerType === 'VECTOR' && x.postgisTable)) {
      const [size] = await this.prisma.$queryRaw<{ bytes: bigint }[]>`
        SELECT pg_total_relation_size(quote_ident(${l.postgisTable})::regclass) AS bytes`.catch(() => [{ bytes: 0n }]);
      rows.push({
        layerId: l.id, name: l.name, department: departments.get(l.departmentId ?? '') ?? 'Municipality-wide',
        kind: 'Vector table', bytes: Number(size?.bytes ?? 0), createdAt: l.createdAt,
      });
    }
    rows.sort((a, b) => b.bytes - a.bytes);
    const perDepartment = [...rows.reduce((m, r) => m.set(r.department, (m.get(r.department) ?? 0) + r.bytes), new Map<string, number>())]
      .map(([department, bytes]) => ({ department, bytes }))
      .sort((a, b) => b.bytes - a.bytes);
    return {
      totalBytes: rows.reduce((a, r) => a + r.bytes, 0),
      tempBytes: tmp.reduce((a, f) => a + f.size, 0),
      orphanBytes,
      perDepartment,
      layers: rows.slice(0, 200),
    };
  }

  /** Removes temp files older than an hour and raster files whose layer
   *  no longer exists. */
  async cleanup(appUser: AppUser) {
    this.assertOwner(appUser);
    const dir = path.join(this.storageRoot, appUser.municipalityId, 'rasters');
    const cutoff = Date.now() - 60 * 60 * 1000;
    let freed = 0;
    let removed = 0;
    for (const f of await this.listFiles(path.join(dir, 'tmp'))) {
      if (f.mtimeMs < cutoff) {
        await fsp.rm(f.path, { force: true });
        freed += f.size;
        removed++;
      }
    }
    const ids = new Set(
      (await this.prisma.gISLayer.findMany({ where: { layerType: 'RASTER' }, select: { id: true } })).map((l) => l.id),
    );
    for (const f of await this.listFiles(dir)) {
      if (f.name.endsWith('.tif') && !ids.has(path.basename(f.name, '.tif')) && f.mtimeMs < cutoff) {
        await fsp.rm(f.path, { force: true });
        await fsp.rm(`${f.path}.aux.xml`, { force: true });
        freed += f.size;
        removed++;
      }
    }
    this.logger.log(`Raster storage clean-up for ${appUser.municipalityId}: ${removed} files, ${freed} bytes`);
    return { removed, freedBytes: freed };
  }

  // ----- Dashboard Pins -----

  listPins(appUser: AppUser) {
    return this.prisma.rasterPin.findMany({
      where: { municipalityId: appUser.municipalityId },
      orderBy: { createdAt: 'desc' },
      take: 24,
    });
  }

  createPin(appUser: AppUser, dto: { title: string; value: string; detail?: string; layerId?: string }) {
    return this.prisma.rasterPin.create({
      data: {
        municipalityId: appUser.municipalityId,
        createdById: appUser.id,
        title: dto.title.trim(),
        value: dto.value.trim(),
        detail: dto.detail?.trim() || null,
        layerId: dto.layerId ?? null,
      },
    });
  }

  async deletePin(appUser: AppUser, id: string): Promise<void> {
    const pin = await this.prisma.rasterPin.findUnique({ where: { id } });
    if (!pin || pin.municipalityId !== appUser.municipalityId) throw new NotFoundException('Pin not found.');
    if (pin.createdById !== appUser.id && appUser.systemRole !== 'MUNICIPALITY_OWNER') {
      throw new ForbiddenException('Only its creator or the owner can remove this pin.');
    }
    await this.prisma.rasterPin.delete({ where: { id } });
  }

  // ----- helpers -----

  private assertOwner(appUser: AppUser): void {
    if (appUser.systemRole !== 'MUNICIPALITY_OWNER') {
      throw new ForbiddenException('Only the municipality owner can manage raster storage.');
    }
  }

  private async listFiles(dir: string) {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: { name: string; path: string; size: number; mtimeMs: number }[] = [];
    for (const e of entries) {
      if (!e.isFile()) continue;
      const p = path.join(dir, e.name);
      const st = await fsp.stat(p).catch(() => null);
      if (st) out.push({ name: e.name, path: p, size: st.size, mtimeMs: st.mtimeMs });
    }
    return out;
  }
}

/** Deep-replaces placeholder strings in a step body. */
function substitute(value: unknown, map: Record<string, string | undefined>): unknown {
  if (typeof value === 'string' && value in map) return map[value];
  if (Array.isArray(value)) return value.map((v) => substitute(v, map));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, map)]));
  }
  return value;
}
