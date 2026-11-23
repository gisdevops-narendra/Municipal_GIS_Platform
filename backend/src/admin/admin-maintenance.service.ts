import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { createReadStream, promises as fsp, type Dirent } from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AppUser } from '../auth/types/app-user.type';

const execFileAsync = promisify(execFile);

/** Files a backup folder may contain (download whitelist). */
const BACKUP_FILES = ['db.dump', 'geoserver-data.tar.gz', 'storage.tar', 'keycloak-realm.json', 'keycloak-users.json', 'SHA256SUMS', 'manifest.txt'];
const RESTORE_PARTS = ['db', 'geoserver', 'storage', 'keycloak'] as const;
const STAMP = /^\d{8}-\d{6}$/;
const DAY = 24 * 60 * 60 * 1000;

export interface RetentionSettings {
  /** temp / scratch files older than this are deleted (min 1) */
  tempDays: number;
  /** Georeferencer scans not opened for this long (0 = keep) */
  georefDays: number;
  /** downloaded imagery cache older than this (0 = keep) */
  cacheDays: number;
  /** original files of uploads already published as layers (0 = keep) */
  publishedOriginalsDays: number;
  /** audit-log entries older than this (0 = keep) */
  auditDays: number;
}

// Safe defaults: only scratch files are removed until an admin opts in to
// deleting anything else (scans, cache, originals, audit history).
const DEFAULT_RETENTION: RetentionSettings = { tempDays: 1, georefDays: 0, cacheDays: 0, publishedOriginalsDays: 0, auditDays: 0 };

export interface CleanupResult {
  at: string;
  by: string;
  freedBytes: number;
  removed: { temp: number; georef: number; cache: number; originals: number; auditRows: number };
}

/**
 * Platform maintenance for Admin: backups (list / verify / download, and
 * "back up now" / restore requests run on the host by
 * scripts/backup-runner.sh) and storage housekeeping (usage breakdown,
 * retention settings, a daily automatic cleanup and "clean up now").
 */
@Injectable()
export class AdminMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AdminMaintenanceService.name);
  private readonly backupsDir: string;
  private readonly storageRoot: string;
  private readonly systemDir: string;
  private timer: ReturnType<typeof setInterval> | undefined;
  private first: ReturnType<typeof setTimeout> | undefined;
  private cleaning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.backupsDir = path.resolve(config.get<string>('BACKUPS_DIR', '/backups'));
    this.storageRoot = path.resolve(config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'));
    this.systemDir = path.join(path.dirname(this.storageRoot), '_system');
  }

  onModuleInit(): void {
    // Daily automatic cleanup; the first one shortly after start-up.
    this.first = setTimeout(() => void this.cleanup('schedule').catch(() => undefined), 10 * 60_000);
    this.timer = setInterval(() => void this.cleanup('schedule').catch(() => undefined), DAY);
  }

  onModuleDestroy(): void {
    clearTimeout(this.first);
    clearInterval(this.timer);
  }

  // =========================== backups ===========================

  private requestsDir(): string {
    return path.join(this.backupsDir, 'requests');
  }

  async listBackups() {
    const auto = path.join(this.backupsDir, 'auto');
    const names = await fsp.readdir(auto).catch(() => [] as string[]);
    const backups = await Promise.all(
      names
        .filter((n) => STAMP.test(n))
        .map(async (stamp) => {
          const dir = path.join(auto, stamp);
          const files = await Promise.all(
            BACKUP_FILES.map(async (f) => {
              const st = await fsp.stat(path.join(dir, f)).catch(() => null);
              return st ? { name: f, bytes: st.size } : null;
            }),
          );
          const keycloak = await fsp.stat(path.join(dir, 'keycloak-h2')).then(() => true).catch(() => false);
          const manifest = await fsp.readFile(path.join(dir, 'manifest.txt'), 'utf8').catch(() => '');
          const [y, mo, d, h, mi, s] = [stamp.slice(0, 4), stamp.slice(4, 6), stamp.slice(6, 8), stamp.slice(9, 11), stamp.slice(11, 13), stamp.slice(13, 15)];
          const present = files.filter((f): f is { name: string; bytes: number } => !!f);
          return {
            stamp,
            takenAt: `${y}-${mo}-${d}T${h}:${mi}:${s}`,
            files: present,
            totalBytes: present.reduce((t, f) => t + f.bytes, 0),
            parts: {
              db: present.some((f) => f.name === 'db.dump'),
              geoserver: present.some((f) => f.name === 'geoserver-data.tar.gz'),
              storage: present.some((f) => f.name === 'storage.tar'),
              keycloak,
            },
            commit: /git commit: (\S+)/.exec(manifest)?.[1] ?? null,
            accounts: Number(/accounts: (\d+)/.exec(manifest)?.[1] ?? NaN) || null,
          };
        }),
    );
    const partial = names.filter((n) => n.endsWith('.partial')).length;
    return { backups: backups.sort((a, b) => b.stamp.localeCompare(a.stamp)), inProgress: partial > 0, requests: await this.listRequests() };
  }

  /** Checks every file against the backup's SHA256SUMS. */
  async verify(stamp: string) {
    const dir = this.backupDir(stamp);
    try {
      await execFileAsync('sha256sum', ['-c', 'SHA256SUMS'], { cwd: dir, timeout: 30 * 60_000, maxBuffer: 1024 * 1024 });
      return { ok: true, message: 'All files match their checksums.' };
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      return { ok: false, message: ((e.stdout ?? '') + (e.stderr ?? '')).trim().split('\n').filter((l) => !/: OK$/.test(l)).slice(0, 10).join('\n') || 'Checksum check failed.' };
    }
  }

  private backupDir(stamp: string): string {
    if (!STAMP.test(stamp)) throw new NotFoundException('Backup not found.');
    return path.join(this.backupsDir, 'auto', stamp);
  }

  async backupFile(stamp: string, file: string) {
    if (!BACKUP_FILES.includes(file)) throw new NotFoundException('File not found.');
    const full = path.join(this.backupDir(stamp), file);
    const st = await fsp.stat(full).catch(() => null);
    if (!st) throw new NotFoundException('File not found.');
    return { stream: createReadStream(full), bytes: st.size, filename: `municipal-gis-${stamp}-${file}` };
  }

  private async listRequests() {
    const dir = this.requestsDir();
    const names = await fsp.readdir(dir).catch(() => [] as string[]);
    const ids = names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n)).map((n) => n.slice(0, -5));
    const rows = await Promise.all(
      ids.map(async (id) => {
        const req = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8').catch(() => '{}')) as Record<string, unknown>;
        const status = JSON.parse(await fsp.readFile(path.join(dir, `${id}.status.json`), 'utf8').catch(() => 'null')) as { state: string; message: string; updatedAt: string } | null;
        return { id, ...req, state: status?.state ?? 'queued', message: status?.message ?? null, updatedAt: status?.updatedAt ?? (req['requestedAt'] as string) };
      }),
    );
    return rows.sort((a, b) => String(b['requestedAt'] ?? '').localeCompare(String(a['requestedAt'] ?? ''))).slice(0, 20);
  }

  private async enqueue(me: AppUser, body: Record<string, unknown>) {
    const pending = (await this.listRequests()).find((r) => r.state === 'queued' || r.state === 'running');
    if (pending) throw new ConflictException('A backup or restore is already queued or running — wait for it to finish.');
    const dir = this.requestsDir();
    await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
    const id = randomUUID();
    const payload = { ...body, requestedAt: new Date().toISOString(), requestedBy: await this.emailOf(me) };
    await fsp.writeFile(path.join(dir, `${id}.json`), JSON.stringify(payload)).catch(() => {
      throw new BadRequestException('Backups are not available on this server (the backups folder is not mounted).');
    });
    return { id, ...payload, state: 'queued' };
  }

  backupNow(me: AppUser, ip: string | null) {
    this.audit.record({ action: 'backup.requested', actorUserId: me.id, ip });
    return this.enqueue(me, { action: 'backup' });
  }

  async restore(me: AppUser, stamp: string, parts: string[], dryRun: boolean, confirm: string, ip: string | null) {
    const dir = this.backupDir(stamp);
    await fsp.stat(dir).catch(() => {
      throw new NotFoundException('Backup not found.');
    });
    if (!dryRun && confirm !== stamp) throw new BadRequestException(`Type the backup name (${stamp}) to confirm the restore.`);
    const chosen = [...new Set(parts)].filter((p) => (RESTORE_PARTS as readonly string[]).includes(p));
    if (!chosen.length) throw new BadRequestException('Choose at least one part to restore.');
    this.audit.record({ action: dryRun ? 'restore.dry_run_requested' : 'restore.requested', actorUserId: me.id, details: { stamp, parts: chosen }, ip });
    return this.enqueue(me, { action: 'restore', stamp, parts: chosen.join(','), dryRun });
  }

  private async emailOf(me: AppUser): Promise<string> {
    const u = await this.prisma.user.findUnique({ where: { id: me.id }, select: { email: true } }).catch(() => null);
    return u?.email ?? me.id;
  }

  // =========================== storage ===========================

  private async dirSize(dir: string, olderThan?: number): Promise<{ bytes: number; files: number }> {
    let bytes = 0;
    let files = 0;
    const walk = async (d: string) => {
      const entries: Dirent[] = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          const st = await fsp.stat(p).catch(() => null);
          if (st && (!olderThan || st.mtimeMs < olderThan)) {
            bytes += st.size;
            files++;
          }
        }
      }
    };
    await walk(dir);
    return { bytes, files };
  }

  private async tenants(): Promise<string[]> {
    const names = await fsp.readdir(this.storageRoot).catch(() => [] as string[]);
    return names.filter((n) => /^[0-9a-f-]{36}$/.test(n));
  }

  /** Disk use by category, the database and backups; retention settings
   *  and the last cleanup. */
  async storage() {
    const categories: Record<string, { bytes: number; files: number }> = {};
    const add = (key: string, v: { bytes: number; files: number }) => {
      const c = (categories[key] ??= { bytes: 0, files: 0 });
      c.bytes += v.bytes;
      c.files += v.files;
    };
    for (const t of await this.tenants()) {
      const base = path.join(this.storageRoot, t);
      add('uploads', await this.dirSize(path.join(base, 'raw')));
      add('rasters', await this.dirSize(path.join(base, 'rasters')));
      add('tiles', await this.dirSize(path.join(base, 'tiles')));
      add('georef', await this.dirSize(path.join(base, 'georef')));
      add('temp', await this.dirSize(path.join(base, 'temporary')));
    }
    add('temp', await this.dirSize(path.join(this.storageRoot, 'tmp-uploads')));
    add('cache', await this.dirSize(path.join(this.storageRoot, '_cache')));
    const [db] = await this.prisma.$queryRawUnsafe<{ bytes: bigint }[]>(`SELECT pg_database_size(current_database()) AS bytes`);
    const tables = await this.prisma.$queryRawUnsafe<{ name: string; bytes: bigint }[]>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = current_schema() ORDER BY 2 DESC LIMIT 8`,
    );
    const layerNames = new Map(
      (await this.prisma.gISLayerUpload.findMany({ where: { postgisTable: { in: tables.map((t) => t.name) } }, select: { postgisTable: true, layerName: true } })).map((u) => [u.postgisTable, u.layerName]),
    );
    const backups = await this.dirSize(path.join(this.backupsDir, 'auto'));
    return {
      categories,
      database: { bytes: Number(db.bytes), largestTables: tables.map((t) => ({ table: t.name, layer: layerNames.get(t.name) ?? null, bytes: Number(t.bytes) })) },
      backups,
      retention: await this.retention(),
      lastCleanup: await this.readJson<CleanupResult | null>('last-cleanup.json', null),
    };
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.systemDir, file), 'utf8')) as T;
    } catch {
      return fallback;
    }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    await fsp.mkdir(this.systemDir, { recursive: true });
    await fsp.writeFile(path.join(this.systemDir, file), JSON.stringify(value, null, 2));
  }

  async retention(): Promise<RetentionSettings> {
    return { ...DEFAULT_RETENTION, ...(await this.readJson<Partial<RetentionSettings>>('retention.json', {})) };
  }

  async setRetention(me: AppUser, value: RetentionSettings, ip: string | null): Promise<RetentionSettings> {
    const clean: RetentionSettings = {
      tempDays: Math.max(1, Math.round(value.tempDays)),
      georefDays: Math.max(0, Math.round(value.georefDays)),
      cacheDays: Math.max(0, Math.round(value.cacheDays)),
      publishedOriginalsDays: Math.max(0, Math.round(value.publishedOriginalsDays)),
      auditDays: value.auditDays > 0 ? Math.max(90, Math.round(value.auditDays)) : 0,
    };
    await this.writeJson('retention.json', clean);
    this.audit.record({ action: 'storage.retention_changed', actorUserId: me.id, details: { ...clean }, ip });
    return clean;
  }

  /** Deletes what the retention settings allow; also runs daily. */
  async cleanup(by: 'schedule' | AppUser): Promise<CleanupResult> {
    if (this.cleaning) throw new ConflictException('A cleanup is already running.');
    this.cleaning = true;
    try {
      const r = await this.retention();
      const now = Date.now();
      const removed = { temp: 0, georef: 0, cache: 0, originals: 0, auditRows: 0 };
      let freed = 0;
      const rmOld = async (dir: string, days: number, key: 'temp' | 'cache') => {
        if (!days) return;
        const cutoff = now - days * DAY;
        const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
        for (const e of entries) {
          const p = path.join(dir, e.name);
          const st = await fsp.stat(p).catch(() => null);
          if (!st || st.mtimeMs >= cutoff) {
            if (st?.isDirectory()) await rmOld(p, days, key); // look inside fresh folders too
            continue;
          }
          const size = st.isDirectory() ? (await this.dirSize(p)).bytes : st.size;
          await fsp.rm(p, { recursive: true, force: true });
          freed += size;
          removed[key]++;
        }
      };

      for (const t of await this.tenants()) {
        const base = path.join(this.storageRoot, t);
        await rmOld(path.join(base, 'temporary'), r.tempDays, 'temp');
        await rmOld(path.join(base, 'rasters', 'tmp'), r.tempDays, 'temp');
        // Georeferencer sessions not touched for georefDays.
        if (r.georefDays) {
          const cutoff = now - r.georefDays * DAY;
          const sessions = await fsp.readdir(path.join(base, 'georef')).catch(() => [] as string[]);
          for (const s of sessions) {
            const dir = path.join(base, 'georef', s);
            const meta = await fsp.stat(path.join(dir, 'session.json')).catch(() => null);
            if (meta && meta.mtimeMs < cutoff) {
              freed += (await this.dirSize(dir)).bytes;
              await fsp.rm(dir, { recursive: true, force: true });
              removed.georef++;
            }
          }
        }
      }
      await rmOld(path.join(this.storageRoot, 'tmp-uploads'), r.tempDays, 'temp');
      await rmOld(path.join(this.storageRoot, '_cache'), r.cacheDays, 'cache');

      // Original files of uploads published as layers long ago (the data
      // itself lives in PostGIS).
      if (r.publishedOriginalsDays) {
        const uploads = await this.prisma.gISLayerUpload.findMany({
          where: { status: 'PUBLISHED', createdAt: { lt: new Date(now - r.publishedOriginalsDays * DAY) } },
          select: { id: true, municipalityId: true },
        });
        for (const u of uploads) {
          const dir = path.join(this.storageRoot, u.municipalityId, 'raw', u.id);
          const size = (await this.dirSize(dir)).bytes;
          if (!size) continue;
          await fsp.rm(dir, { recursive: true, force: true });
          freed += size;
          removed.originals++;
        }
      }

      if (r.auditDays) {
        removed.auditRows = await this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: new Date(now - r.auditDays * DAY) } } }).then((x) => x.count);
      }

      const result: CleanupResult = {
        at: new Date().toISOString(),
        by: by === 'schedule' ? 'daily schedule' : await this.emailOf(by),
        freedBytes: freed,
        removed,
      };
      await this.writeJson('last-cleanup.json', result);
      this.audit.record({
        action: 'storage.cleanup',
        actorUserId: by === 'schedule' ? null : by.id,
        actorEmail: by === 'schedule' ? 'schedule' : null,
        details: { freedBytes: freed, ...removed },
      });
      this.logger.log(`Storage cleanup freed ${(freed / 1048576).toFixed(1)} MB`);
      return result;
    } finally {
      this.cleaning = false;
    }
  }
}
