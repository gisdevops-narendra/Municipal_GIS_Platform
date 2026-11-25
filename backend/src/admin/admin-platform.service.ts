import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'crypto';
import { promises as fsp, statfsSync } from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { GeoServerService } from '../gis/geoserver.service';
import { RasterJobsService } from '../gis/raster-jobs.service';
import { RasterMailService } from '../gis/raster-mail.service';
import { MunicipalitiesService } from '../municipalities/municipalities.service';
import { PlatformSettingsService, type Announcement, type Branding, type EmailSettings, type Maintenance, type ModuleSwitches } from '../platform/platform-settings.service';
import { LOG_BUFFER } from '../platform/log-buffer';
import { LOGO_DIR } from '../platform/platform.controller';
import type { AppUser } from '../auth/types/app-user.type';
import { SWITCHABLE_TOOLS } from '../platform/module-catalog';

const DAY = 86_400_000;

/** Tool ids the Modules screen can switch off (workspace tool ids). */

/**
 * Admin console: Users, Health, Jobs, Logs, Security, Email, Branding,
 * Announcements, Modules, Analytics and Data check.
 */
@Injectable()
export class AdminPlatformService {
  private readonly logger = new Logger(AdminPlatformService.name);
  private readonly keycloakUrl: string;
  private readonly realm: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly keycloak: KeycloakAdminService,
    private readonly geoServer: GeoServerService,
    private readonly jobs: RasterJobsService,
    private readonly mail: RasterMailService,
    private readonly municipalities: MunicipalitiesService,
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {
    this.keycloakUrl = config.get<string>('KEYCLOAK_INTERNAL_URL') ?? config.get<string>('KEYCLOAK_URL', 'http://keycloak:8080');
    this.realm = config.get<string>('KEYCLOAK_REALM', 'municipal-gis');
  }

  // =============================== Users ===============================

  async listUsers(q: string, page: number, pageSize: number) {
    const where = q
      ? { OR: [{ email: { contains: q, mode: 'insensitive' as const } }, { fullName: { contains: q, mode: 'insensitive' as const } }, { municipality: { name: { contains: q, mode: 'insensitive' as const } } }] }
      : {};
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, fullName: true, email: true, status: true, isPlatformAdmin: true, createdAt: true, lastSeenAt: true, keycloakUserId: true, municipality: { select: { id: true, name: true } } },
      }),
    ]);
    const verified = await Promise.all(rows.map((u) => this.keycloak.getUser(u.keycloakUserId).then((k) => k?.emailVerified ?? null).catch(() => null)));
    return {
      total,
      page,
      pageSize,
      rows: rows.map(({ keycloakUserId: _k, ...u }, i) => ({ ...u, account: u.municipality, emailVerified: verified[i] })),
    };
  }

  private async user(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u) throw new NotFoundException('User not found.');
    return u;
  }

  /** New person: their own account and workspace, plus an email to set a
   *  password and verify the address (the link is valid 7 days). */
  async invite(me: AppUser, email: string, fullName: string, ip: string | null) {
    const tempPassword = `${randomBytes(18).toString('base64url')}aA1!`;
    const result = (await this.municipalities.registerAccount({ email, fullName, password: tempPassword } as never, ip ?? undefined)) as unknown;
    const user = await this.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user) throw new BadRequestException('The account could not be created.');
    let emailed = true;
    try {
      await this.keycloak.executeActionsEmail(user.keycloakUserId, ['UPDATE_PASSWORD', 'VERIFY_EMAIL']);
    } catch {
      emailed = false;
    }
    this.audit.record({ action: 'admin.user_invited', actorUserId: me.id, accountId: user.municipalityId, details: { email: user.email, emailed }, ip });
    void result;
    return { id: user.id, email: user.email, emailed };
  }

  async updateUser(me: AppUser, id: string, change: { fullName?: string; email?: string }, ip: string | null) {
    const u = await this.user(id);
    if (change.fullName && change.fullName.trim() !== u.fullName) {
      await this.keycloak.updateName(u.keycloakUserId, change.fullName);
      await this.prisma.user.update({ where: { id }, data: { fullName: change.fullName.trim() } });
    }
    if (change.email && change.email.trim().toLowerCase() !== u.email) {
      const email = change.email.trim().toLowerCase();
      if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('Another user already has this email.');
      await this.keycloak.updateEmail(u.keycloakUserId, email);
      await this.prisma.user.update({ where: { id }, data: { email } });
    }
    this.audit.record({ action: 'admin.user_updated', actorUserId: me.id, accountId: u.municipalityId, details: { email: u.email, ...change }, ip });
    return { success: true };
  }

  async sendPasswordReset(me: AppUser, id: string, ip: string | null) {
    const u = await this.user(id);
    await this.keycloak.executeActionsEmail(u.keycloakUserId, ['UPDATE_PASSWORD'], 24 * 3600);
    this.audit.record({ action: 'admin.password_reset_sent', actorUserId: me.id, accountId: u.municipalityId, details: { email: u.email }, ip });
    return { success: true };
  }

  async sendVerification(me: AppUser, id: string, ip: string | null) {
    const u = await this.user(id);
    await this.keycloak.executeActionsEmail(u.keycloakUserId, ['VERIFY_EMAIL'], 7 * 24 * 3600);
    this.audit.record({ action: 'admin.verification_sent', actorUserId: me.id, accountId: u.municipalityId, details: { email: u.email }, ip });
    return { success: true };
  }

  async setPlatformAdmin(me: AppUser, id: string, value: boolean, ip: string | null) {
    if (id === me.id && !value) throw new BadRequestException('You cannot remove your own admin rights.');
    const u = await this.user(id);
    await this.prisma.user.update({ where: { id }, data: { isPlatformAdmin: value } });
    this.audit.record({ action: value ? 'admin.granted' : 'admin.revoked', actorUserId: me.id, accountId: u.municipalityId, details: { email: u.email }, ip });
    return { success: true };
  }

  // =============================== Health ===============================

  private async probe(name: string, fn: () => Promise<string | void>): Promise<{ name: string; ok: boolean; detail: string; ms: number }> {
    const t = Date.now();
    try {
      const detail = (await Promise.race([fn(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('No answer within 6 s')), 6000))])) ?? 'OK';
      return { name, ok: true, detail, ms: Date.now() - t };
    } catch (error) {
      return { name, ok: false, detail: (error as Error).message.slice(0, 200), ms: Date.now() - t };
    }
  }

  private async httpOk(url: string): Promise<string> {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'OK';
  }

  private tcp(host: string, port: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const s = net.connect({ host, port, timeout: 5000 }, () => {
        s.end();
        resolve(`Listening on ${host}:${port}`);
      });
      s.on('error', reject);
      s.on('timeout', () => {
        s.destroy();
        reject(new Error('Timed out'));
      });
    });
  }

  async health() {
    const email = await this.settings.get('email');
    const services = await Promise.all([
      this.probe('Database', async () => {
        const [v] = await this.prisma.$queryRawUnsafe<{ v: string }[]>(`SELECT split_part(version(), ' ', 2) AS v`);
        return `PostgreSQL ${v.v}`;
      }),
      this.probe('GeoServer', async () => {
        const h = await this.geoServer.checkHealth();
        if (!h.reachable) throw new Error(h.message ?? 'Unreachable');
        return `GeoServer ${h.version ?? ''}`.trim();
      }),
      this.probe('Login (Keycloak)', () => this.httpOk(`${this.keycloakUrl}/realms/${this.realm}`)),
      this.probe('AI service', () => this.httpOk(`${this.config.get<string>('GIS_AI_URL', 'http://gis-ai:8000')}/health`)),
      this.probe('AI model (Ollama)', () => this.httpOk('http://ollama:11434/api/tags')),
      // TiTiler is on its own network — the Health screen checks it from the browser.
      this.probe('Print (MapFish)', () => this.httpOk(`${this.config.get<string>('MAPFISH_PRINT_URL', 'http://mapfish-print:8080/print')}/apps.json`)),
      this.probe('Email (SMTP)', () => this.tcp(email.host, email.port)),
    ]);

    const mem = await fsp.readFile('/proc/meminfo', 'utf8').catch(() => '');
    const kb = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(mem)?.[1] ?? 0) * 1024;
    const [l1, l5, l15] = os.loadavg();
    let disk: { total: number; free: number } | null = null;
    for (const p of ['/backups', '/']) {
      try {
        const st = statfsSync(p);
        disk = { total: st.blocks * st.bsize, free: st.bavail * st.bsize };
        break;
      } catch {
        /* try the next path */
      }
    }
    const since = new Date(Date.now() - 7 * DAY);
    const restarts = await this.prisma.auditLog.count({ where: { action: 'system.geoserver_restarted', createdAt: { gte: since } } });
    return {
      checkedAt: new Date().toISOString(),
      services,
      system: {
        cpus: os.cpus().length,
        load: [l1, l5, l15],
        memory: { total: kb('MemTotal'), available: kb('MemAvailable') },
        swap: { total: kb('SwapTotal'), free: kb('SwapFree') },
        disk,
        uptimeSeconds: os.uptime(),
      },
      geoserverRestarts7d: restarts,
    };
  }

  async geoserverAction(me: AppUser, action: 'reload' | 'clear-cache' | 'restart', ip: string | null) {
    if (action === 'reload') await this.geoServer.reloadCatalog();
    else if (action === 'clear-cache') await this.geoServer.truncateAllTiles();
    else {
      // The backend cannot run Docker — the host runner restarts it.
      const dir = path.join(path.resolve(this.config.get<string>('BACKUPS_DIR', '/backups')), 'requests');
      await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
      await fsp.writeFile(path.join(dir, `${randomUUID()}.json`), JSON.stringify({ action: 'restart-geoserver', requestedAt: new Date().toISOString() })).catch(() => {
        throw new BadRequestException('Restart is not available on this server (the requests folder is not mounted).');
      });
    }
    this.audit.record({ action: `admin.geoserver_${action.replace('-', '_')}`, actorUserId: me.id, ip });
    return { success: true };
  }

  // =============================== Jobs ===============================

  async jobsOverview() {
    const running = this.jobs.adminList();
    const users = await this.prisma.user.findMany({ where: { id: { in: running.map((j) => j.userId) } }, select: { id: true, email: true } });
    const emails = new Map(users.map((u) => [u.id, u.email]));
    const recent = await this.prisma.rasterJobHistory.findMany({
      where: { createdAt: { gte: new Date(Date.now() - 7 * DAY) } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, tool: true, status: true, summary: true, layerName: true, createdAt: true, finishedAt: true, userId: true },
    });
    const recentUsers = await this.prisma.user.findMany({ where: { id: { in: [...new Set(recent.map((r) => r.userId))] } }, select: { id: true, email: true } });
    const recentEmails = new Map(recentUsers.map((u) => [u.id, u.email]));

    const backupsDir = path.resolve(this.config.get<string>('BACKUPS_DIR', '/backups'));
    const stamps = (await fsp.readdir(path.join(backupsDir, 'auto')).catch(() => [] as string[])).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort();
    const lastStamp = stamps[stamps.length - 1];
    const lastBackupFailed = await this.prisma.auditLog.findFirst({ where: { action: { in: ['backup.completed', 'backup.failed'] } }, orderBy: { createdAt: 'desc' } });
    const lastCleanup = JSON.parse(await fsp.readFile(path.join(path.dirname(path.resolve(this.config.get<string>('GIS_UPLOAD_STORAGE_DIR', './storage/uploads'))), '_system', 'last-cleanup.json'), 'utf8').catch(() => 'null')) as { at: string; freedBytes: number } | null;
    const lastRestart = await this.prisma.auditLog.findFirst({ where: { action: 'system.geoserver_restarted' }, orderBy: { createdAt: 'desc' } });
    const next = (h: number, m: number) => {
      const d = new Date();
      d.setHours(h, m, 0, 0);
      if (d <= new Date()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    };
    const stampIso = (s?: string) => (s ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}` : null);
    return {
      running: running.map((j) => ({ ...j, userEmail: emails.get(j.userId) ?? null })),
      recent: recent.map((r) => ({ ...r, userEmail: recentEmails.get(r.userId) ?? null })),
      schedules: [
        { name: 'Nightly backup', when: 'Every night at 02:30', lastRun: stampIso(lastStamp), lastResult: lastBackupFailed?.action === 'backup.failed' ? 'failed' : lastStamp ? 'ok' : null, nextRun: next(2, 30) },
        { name: 'Storage cleanup', when: 'Daily', lastRun: lastCleanup?.at ?? null, lastResult: lastCleanup ? 'ok' : null, nextRun: null },
        { name: 'GeoServer watchdog', when: 'Every minute — restarts a hung GeoServer', lastRun: null, lastResult: lastRestart ? `last restart ${lastRestart.createdAt.toISOString()}` : 'no restarts', nextRun: null },
      ],
    };
  }

  cancelJob(me: AppUser, id: string, ip: string | null) {
    const job = this.jobs.adminCancel(id);
    this.audit.record({ action: 'admin.job_cancelled', actorUserId: me.id, details: { jobId: id }, ip });
    return job;
  }

  // =============================== Logs ===============================

  async logs(source: 'backend' | 'geoserver', level: string, q: string, limit: number) {
    const needle = q.trim().toLowerCase();
    if (source === 'backend') {
      return LOG_BUFFER.filter((e) => (!level || e.level === level) && (!needle || `${e.context} ${e.message}`.toLowerCase().includes(needle)))
        .slice(-limit)
        .reverse();
    }
    // GeoServer: the tail of its log file (data volume mounted read-only).
    const file = path.join(this.config.get<string>('GEOSERVER_DATA_MOUNT', '/geoserver-data'), 'logs', 'geoserver.log');
    const handle = await fsp.open(file, 'r').catch(() => null);
    if (!handle) throw new BadRequestException('GeoServer logs are not available on this server (its data folder is not mounted).');
    try {
      const { size } = await handle.stat();
      const length = Math.min(size, 2 * 1024 * 1024);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      // Entries start with "23 Nov 08:48:41 LEVEL [logger] - message".
      const entries: { at: string; level: string; context: string; message: string }[] = [];
      for (const line of buf.toString('utf8').split('\n')) {
        const m = /^(\d{2} \w{3} \d{2}:\d{2}:\d{2}) (\w+)\s+\[([^\]]*)\] - ?(.*)$/.exec(line);
        if (m) entries.push({ at: m[1], level: m[2].toLowerCase(), context: m[3], message: m[4] });
        else if (entries.length && line.trim() && entries[entries.length - 1].message.length < 3000) entries[entries.length - 1].message += `\n${line}`;
      }
      const wanted = (l: string) => (!level ? l === 'warn' || l === 'error' || l === 'severe' : level === 'error' ? l === 'error' || l === 'severe' : l === level);
      for (const e of entries) e.message = e.message.replace(/^\s*\n/, '').trim();
      return entries.filter((e) => wanted(e.level) && (!needle || `${e.context} ${e.message}`.toLowerCase().includes(needle))).slice(-limit).reverse();
    } finally {
      await handle.close();
    }
  }

  // =============================== Security ===============================

  /** Parses Keycloak's passwordPolicy string, e.g. "length(10) and digits(1)". */
  private parsePolicy(policy: string) {
    const num = (k: string) => Number(new RegExp(`${k}\\((\\d+)\\)`).exec(policy)?.[1] ?? 0);
    return { minLength: num('length'), digits: num('digits'), upperCase: num('upperCase'), specialChars: num('specialChars'), notUsername: /notUsername/.test(policy), expireDays: num('forceExpiredPasswordChange') };
  }

  async security() {
    const realm = await this.keycloak.getRealm().catch(() => null);
    const canManage = !!realm && 'smtpServer' in realm;
    const totp = realm ? await this.totpDefault() : false;
    const [apiKeys, shareLinks] = await Promise.all([
      this.prisma.apiKey.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { municipality: { select: { name: true } } } }),
      this.prisma.gISShareLink.findMany({ orderBy: { createdAt: 'desc' }, take: 200, include: { municipality: { select: { name: true } } } }),
    ]);
    return {
      canManageRealm: canManage,
      policy: this.parsePolicy(String(realm?.['passwordPolicy'] ?? '')),
      bruteForce: { enabled: !!realm?.['bruteForceProtected'], failures: Number(realm?.['failureFactor'] ?? 30), lockMinutes: Math.round(Number(realm?.['maxFailureWaitSeconds'] ?? 900) / 60) },
      sessionIdleMinutes: Math.round(Number(realm?.['ssoSessionIdleTimeout'] ?? 1800) / 60),
      requireTwoFactor: totp,
      apiKeys: apiKeys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, account: k.municipality.name, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt })),
      shareLinks: shareLinks.map((l) => ({ id: l.id, title: l.title, account: l.municipality.name, createdAt: l.createdAt, expiresAt: l.expiresAt, revokedAt: l.revokedAt, viewCount: l.viewCount, lastViewedAt: l.lastViewedAt })),
    };
  }

  private async totpDefault(): Promise<boolean> {
    try {
      const token = await (this.keycloak as unknown as { getAdminAccessToken(): Promise<string> }).getAdminAccessToken();
      const res = await fetch(`${this.keycloakUrl}/admin/realms/${this.realm}/authentication/required-actions/CONFIGURE_TOTP`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return false;
      return !!((await res.json()) as { defaultAction?: boolean }).defaultAction;
    } catch {
      return false;
    }
  }

  async setSecurity(
    me: AppUser,
    dto: { minLength: number; digits: number; upperCase: number; specialChars: number; notUsername: boolean; expireDays: number; bruteForce: boolean; failures: number; lockMinutes: number; sessionIdleMinutes: number; requireTwoFactor: boolean },
    ip: string | null,
  ) {
    const parts = [
      dto.minLength ? `length(${dto.minLength})` : '',
      dto.digits ? `digits(${dto.digits})` : '',
      dto.upperCase ? `upperCase(${dto.upperCase})` : '',
      dto.specialChars ? `specialChars(${dto.specialChars})` : '',
      dto.notUsername ? 'notUsername(undefined)' : '',
      dto.expireDays ? `forceExpiredPasswordChange(${dto.expireDays})` : '',
    ].filter(Boolean);
    await this.keycloak.updateRealm({
      passwordPolicy: parts.join(' and '),
      bruteForceProtected: dto.bruteForce,
      failureFactor: dto.failures,
      maxFailureWaitSeconds: dto.lockMinutes * 60,
      waitIncrementSeconds: 60,
      ssoSessionIdleTimeout: dto.sessionIdleMinutes * 60,
    });
    // Two-factor: new users must set it up; existing users at next sign-in.
    const token = await (this.keycloak as unknown as { getAdminAccessToken(): Promise<string> }).getAdminAccessToken();
    const ra = `${this.keycloakUrl}/admin/realms/${this.realm}/authentication/required-actions/CONFIGURE_TOTP`;
    const cur = await fetch(ra, { headers: { Authorization: `Bearer ${token}` } }).then((r) => (r.ok ? r.json() : null));
    if (cur) {
      await fetch(ra, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, enabled: true, defaultAction: dto.requireTwoFactor }) });
    }
    const added = dto.requireTwoFactor ? await this.keycloak.addRequiredActionToAll('CONFIGURE_TOTP') : 0;
    this.audit.record({ action: 'admin.security_changed', actorUserId: me.id, details: { ...dto, twoFactorAddedTo: added }, ip });
    return this.security();
  }

  async revokeApiKey(me: AppUser, id: string, ip: string | null) {
    await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    this.audit.record({ action: 'admin.api_key_revoked', actorUserId: me.id, details: { id }, ip });
    return { success: true };
  }

  async revokeShareLink(me: AppUser, id: string, ip: string | null) {
    await this.prisma.gISShareLink.update({ where: { id }, data: { revokedAt: new Date() } });
    this.audit.record({ action: 'admin.share_link_revoked', actorUserId: me.id, details: { id }, ip });
    return { success: true };
  }

  // =============================== Email ===============================

  async email() {
    const e = await this.settings.get('email');
    return { ...e, password: undefined, hasPassword: !!e.password };
  }

  /** Saves the SMTP server for app emails and (when allowed) Keycloak's
   *  password-reset / verification emails. */
  async setEmail(me: AppUser, dto: EmailSettings, ip: string | null) {
    const current = await this.settings.get('email');
    const value: EmailSettings = { ...dto, password: dto.password ? dto.password : current.password };
    await this.settings.set('email', value);
    let keycloak = 'updated';
    try {
      await this.keycloak.updateRealm({
        smtpServer: {
          host: value.host,
          port: String(value.port),
          from: value.from,
          fromDisplayName: value.fromName,
          starttls: String(value.starttls),
          ssl: String(value.ssl),
          auth: String(value.auth),
          ...(value.auth ? { user: value.user, password: value.password ?? '' } : {}),
        },
      });
    } catch (error) {
      keycloak = (error as Error).message;
    }
    this.audit.record({ action: 'admin.email_changed', actorUserId: me.id, details: { host: value.host, port: value.port, from: value.from }, ip });
    return { ...(await this.email()), keycloak };
  }

  async testEmail(me: AppUser, to: string) {
    const ok = await this.mail.send(to, 'Test email from Municipal GIS', 'This is a test email from the Admin console — your email settings work.');
    if (!ok) throw new BadRequestException('The test email could not be sent — check the server address and port.');
    return { success: true };
  }

  // =============================== Branding ===============================

  branding(): Promise<Branding> {
    return this.settings.get('branding');
  }

  async setBranding(me: AppUser, dto: Omit<Branding, 'hasLogo' | 'logoVersion'>, ip: string | null) {
    const cur = await this.settings.get('branding');
    const value = await this.settings.set('branding', { ...cur, ...dto });
    this.audit.record({ action: 'admin.branding_changed', actorUserId: me.id, ip });
    return value;
  }

  async setLogo(me: AppUser, file: { path: string; originalname: string; size: number } | undefined) {
    if (!file?.path) throw new BadRequestException('Choose a logo image.');
    const ext = path.extname(file.originalname).toLowerCase();
    try {
      if (!['.png', '.svg', '.jpg', '.jpeg', '.webp'].includes(ext)) throw new BadRequestException('Use a PNG, SVG, JPEG or WEBP image.');
      if (file.size > 1024 * 1024) throw new BadRequestException('The logo must be under 1 MB.');
      const dir = LOGO_DIR();
      await fsp.mkdir(dir, { recursive: true });
      for (const f of await fsp.readdir(dir)) if (/^logo\./.test(f)) await fsp.rm(path.join(dir, f), { force: true });
      await fsp.copyFile(file.path, path.join(dir, `logo${ext}`));
    } finally {
      await fsp.rm(file.path, { force: true });
    }
    const cur = await this.settings.get('branding');
    return this.settings.set('branding', { ...cur, hasLogo: true, logoVersion: (cur.logoVersion ?? 0) + 1 });
  }

  async removeLogo() {
    const dir = LOGO_DIR();
    for (const f of await fsp.readdir(dir).catch(() => [] as string[])) if (/^logo\./.test(f)) await fsp.rm(path.join(dir, f), { force: true });
    const cur = await this.settings.get('branding');
    return this.settings.set('branding', { ...cur, hasLogo: false, logoVersion: (cur.logoVersion ?? 0) + 1 });
  }

  // =============================== Announcements ===============================

  async notices() {
    return { announcement: await this.settings.get('announcement'), maintenance: await this.settings.get('maintenance') };
  }

  async setAnnouncement(me: AppUser, dto: Announcement, ip: string | null) {
    const v = await this.settings.set('announcement', dto);
    this.audit.record({ action: 'admin.announcement_changed', actorUserId: me.id, details: { enabled: dto.enabled }, ip });
    return v;
  }

  async setMaintenance(me: AppUser, dto: Maintenance, ip: string | null) {
    const v = await this.settings.set('maintenance', dto);
    this.audit.record({ action: dto.enabled ? 'admin.maintenance_on' : 'admin.maintenance_off', actorUserId: me.id, ip });
    return v;
  }

  // =============================== Modules ===============================

  async modules() {
    const accounts = await this.prisma.municipality.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } });
    return { tools: SWITCHABLE_TOOLS, switches: await this.settings.get('modules'), accounts };
  }

  async setModules(me: AppUser, dto: ModuleSwitches, ip: string | null) {
    const known = new Set(SWITCHABLE_TOOLS.flatMap((t) => [t.id, ...(t.children ?? []).map((c) => c.id)]));
    const clean: ModuleSwitches = {
      global: [...new Set(dto.global.filter((t) => known.has(t)))],
      perAccount: Object.fromEntries(Object.entries(dto.perAccount ?? {}).map(([k, v]) => [k, [...new Set(v.filter((t) => known.has(t)))]]).filter(([, v]) => (v as string[]).length)),
    };
    const v = await this.settings.set('modules', clean);
    this.audit.record({ action: 'admin.modules_changed', actorUserId: me.id, details: { off: clean.global }, ip });
    return v;
  }

  // =============================== Analytics ===============================

  async analytics(days: number) {
    const since = new Date(Date.now() - days * DAY);
    since.setUTCHours(0, 0, 0, 0);
    const [active, uploads, layers, tools, totals] = await Promise.all([
      this.prisma.$queryRawUnsafe<{ day: Date; n: bigint }[]>(`SELECT day, count(*) AS n FROM user_activity_days WHERE day >= $1 GROUP BY day ORDER BY day`, since),
      this.prisma.$queryRawUnsafe<{ day: Date; n: bigint }[]>(`SELECT date_trunc('day', created_at)::date AS day, count(*) AS n FROM gis_layer_uploads WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, since),
      this.prisma.$queryRawUnsafe<{ day: Date; n: bigint }[]>(`SELECT date_trunc('day', created_at)::date AS day, count(*) AS n FROM gis_layers WHERE created_at >= $1 GROUP BY 1 ORDER BY 1`, since),
      this.prisma.$queryRawUnsafe<{ tool: string; n: bigint }[]>(`SELECT tool, sum(count) AS n FROM tool_usage_days WHERE day >= $1 GROUP BY tool ORDER BY 2 DESC LIMIT 15`, since),
      this.prisma.$queryRawUnsafe<{ users: bigint; active7: bigint; active30: bigint; accounts: bigint; layers: bigint }[]>(
        `SELECT (SELECT count(*) FROM users) AS users,
                (SELECT count(DISTINCT user_id) FROM user_activity_days WHERE day >= current_date - 6) AS active7,
                (SELECT count(DISTINCT user_id) FROM user_activity_days WHERE day >= current_date - 29) AS active30,
                (SELECT count(*) FROM municipalities) AS accounts,
                (SELECT count(*) FROM gis_layers) AS layers`,
      ),
    ]);
    const series = (rows: { day: Date; n: bigint }[]) => rows.map((r) => ({ day: new Date(r.day).toISOString().slice(0, 10), n: Number(r.n) }));
    const t = totals[0];
    return {
      days,
      totals: { users: Number(t.users), active7: Number(t.active7), active30: Number(t.active30), accounts: Number(t.accounts), layers: Number(t.layers) },
      activeUsers: series(active),
      uploads: series(uploads),
      layersCreated: series(layers),
      topTools: tools.map((r) => ({ tool: r.tool, n: Number(r.n) })),
    };
  }

  // =============================== Data check ===============================

  /** Finds inconsistencies between the database, GeoServer and disk. */
  async integrity() {
    const layers = await this.prisma.gISLayer.findMany({ select: { id: true, name: true, code: true, layerType: true, geoserverWorkspace: true, geoserverLayer: true, gisWorkspaceId: true } });
    const uploads = await this.prisma.gISLayerUpload.findMany({ where: { postgisTable: { not: null } }, select: { postgisTable: true, status: true, layerName: true } });
    const gsLayers = new Set(await this.geoServer.listAllLayers());
    const expected = new Set(layers.map((l) => `${l.geoserverWorkspace}:${l.geoserverLayer}`));
    const tables = await this.prisma.$queryRawUnsafe<{ name: string; bytes: bigint }[]>(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid) AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r' AND n.nspname = current_schema() AND c.relname LIKE 'layer\\_%'`,
    );
    // A table is in use when a layer, any upload or a saved version points
    // at it — only tables referenced by none of them are leftovers.
    const refs = await this.prisma.$queryRawUnsafe<{ t: string }[]>(
      `SELECT postgis_table AS t FROM gis_layers WHERE postgis_table IS NOT NULL
       UNION SELECT postgis_table FROM gis_layer_uploads WHERE postgis_table IS NOT NULL
       UNION SELECT postgis_table FROM gis_layer_snapshots WHERE postgis_table IS NOT NULL`,
    );
    const usedTables = new Set(refs.map((r) => r.t));
    void uploads;
    const issues: { kind: string; id: string; title: string; detail: string; fixable: boolean }[] = [];
    if (gsLayers.size) {
      for (const l of layers) {
        if (!gsLayers.has(`${l.geoserverWorkspace}:${l.geoserverLayer}`)) {
          issues.push({ kind: 'missing-in-geoserver', id: l.id, title: `"${l.name}" is not published in GeoServer`, detail: `${l.geoserverWorkspace}:${l.geoserverLayer} — the layer can't draw. Re-publish it from the Layers panel (re-upload), or delete it.`, fixable: false });
        }
      }
      for (const g of gsLayers) {
        if (!expected.has(g)) {
          issues.push({ kind: 'orphan-geoserver-layer', id: g, title: `GeoServer layer "${g}" belongs to no app layer`, detail: 'Left over from a deleted layer. Fix removes it from GeoServer.', fixable: true });
        }
      }
    }
    for (const t of tables) {
      if (!usedTables.has(t.name)) {
        issues.push({ kind: 'orphan-table', id: t.name, title: `Database table ${t.name} belongs to no layer`, detail: `${(Number(t.bytes) / 1048576).toFixed(1)} MB — left over from a failed or discarded upload. Fix drops the table.`, fixable: true });
      }
    }
    return { checkedAt: new Date().toISOString(), counts: { layers: layers.length, geoserverLayers: gsLayers.size, tables: tables.length }, issues };
  }

  async fixIntegrity(me: AppUser, kind: string, id: string, ip: string | null) {
    const current = await this.integrity();
    const issue = current.issues.find((i) => i.kind === kind && i.id === id && i.fixable);
    if (!issue) throw new NotFoundException('That problem was not found any more — run the check again.');
    if (kind === 'orphan-geoserver-layer') await this.geoServer.deleteLayerByName(id);
    else if (kind === 'orphan-table') {
      if (!/^layer_[a-z0-9_]+$/.test(id)) throw new BadRequestException('Unexpected table name.');
      await this.prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${id}"`);
    }
    this.audit.record({ action: 'admin.integrity_fixed', actorUserId: me.id, details: { kind, id }, ip });
    return { success: true };
  }
}
