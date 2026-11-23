import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

export interface AdminStats {
  accounts: number;
  users: number;
  disabledUsers: number;
  layers: number;
  newAccountsLast7Days: number;
  failedUploadsLast7Days: number;
}

export interface AdminUser {
  id: string;
  fullName: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  isPlatformAdmin: boolean;
  createdAt: string;
  /** A delete for this person is running on the server. */
  deleting?: boolean;
}

export interface AdminAccount {
  id: string;
  name: string;
  createdAt: string;
  workspaceStatus: string | null;
  quotaMb: number | null;
  usedBytes: number;
  layerCount: number;
  users: AdminUser[];
  owner: AdminUser | null;
}

export interface AuditEntry {
  id: string;
  createdAt: string;
  actorUserId: string | null;
  actorEmail: string | null;
  accountId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  ip: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** /api/admin/* — platform administrators only. */
@Injectable({ providedIn: 'root' })
export class AdminService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/admin`;

  stats(): Observable<AdminStats> {
    return this.http.get<AdminStats>(`${this.base}/stats`);
  }

  // ----- users -----
  users(q: string, page: number): Observable<{ total: number; page: number; pageSize: number; rows: PlatformUser[] }> {
    return this.http.get<{ total: number; page: number; pageSize: number; rows: PlatformUser[] }>(`${this.base}/users`, { params: { q, page } });
  }
  inviteUser(email: string, fullName: string): Observable<{ id: string; email: string; emailed: boolean }> {
    return this.http.post<{ id: string; email: string; emailed: boolean }>(`${this.base}/users/invite`, { email, fullName });
  }
  updateUser(id: string, change: { fullName?: string; email?: string }): Observable<unknown> {
    return this.http.patch(`${this.base}/users/${id}`, change);
  }
  sendPasswordReset(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/users/${id}/reset-password`, {});
  }
  sendVerification(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/users/${id}/verify-email`, {});
  }
  setPlatformAdmin(id: string, value: boolean): Observable<unknown> {
    return this.http.put(`${this.base}/users/${id}/platform-admin`, { value });
  }

  // ----- health / jobs / logs -----
  health(): Observable<HealthReport> {
    return this.http.get<HealthReport>(`${this.base}/health`);
  }
  geoserverAction(action: 'reload' | 'clear-cache' | 'restart'): Observable<unknown> {
    return this.http.post(`${this.base}/geoserver/${action}`, {});
  }
  jobs(): Observable<JobsOverview> {
    return this.http.get<JobsOverview>(`${this.base}/jobs`);
  }
  cancelJob(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/jobs/${id}/cancel`, {});
  }
  logs(source: 'backend' | 'geoserver', level: string, q: string): Observable<LogEntry[]> {
    return this.http.get<LogEntry[]>(`${this.base}/logs`, { params: { source, level, q } });
  }

  // ----- security / email -----
  security(): Observable<SecurityReport> {
    return this.http.get<SecurityReport>(`${this.base}/security`);
  }
  setSecurity(s: SecuritySettings): Observable<SecurityReport> {
    return this.http.put<SecurityReport>(`${this.base}/security`, s);
  }
  revokeApiKey(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/api-keys/${id}/revoke`, {});
  }
  revokeShareLink(id: string): Observable<unknown> {
    return this.http.post(`${this.base}/share-links/${id}/revoke`, {});
  }
  email(): Observable<EmailSettings> {
    return this.http.get<EmailSettings>(`${this.base}/email`);
  }
  setEmail(e: EmailSettings): Observable<EmailSettings & { keycloak: string }> {
    return this.http.put<EmailSettings & { keycloak: string }>(`${this.base}/email`, e);
  }
  testEmail(to: string): Observable<unknown> {
    return this.http.post(`${this.base}/email/test`, { to });
  }

  // ----- branding / notices / modules -----
  branding(): Observable<Branding> {
    return this.http.get<Branding>(`${this.base}/branding`);
  }
  setBranding(b: Pick<Branding, 'platformName' | 'tagline' | 'loginMessage' | 'primaryColor'>): Observable<Branding> {
    return this.http.put<Branding>(`${this.base}/branding`, b);
  }
  uploadLogo(file: File): Observable<Branding> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<Branding>(`${this.base}/branding/logo`, form);
  }
  removeLogo(): Observable<Branding> {
    return this.http.delete<Branding>(`${this.base}/branding/logo`);
  }
  notices(): Observable<{ announcement: Announcement; maintenance: Maintenance }> {
    return this.http.get<{ announcement: Announcement; maintenance: Maintenance }>(`${this.base}/notices`);
  }
  setAnnouncement(a: Announcement): Observable<Announcement> {
    return this.http.put<Announcement>(`${this.base}/announcement`, a);
  }
  setMaintenance(m: Maintenance): Observable<Maintenance> {
    return this.http.put<Maintenance>(`${this.base}/maintenance`, m);
  }
  modules(): Observable<ModulesConfig> {
    return this.http.get<ModulesConfig>(`${this.base}/modules`);
  }
  setModules(s: ModuleSwitches): Observable<ModuleSwitches> {
    return this.http.put<ModuleSwitches>(`${this.base}/modules`, s);
  }

  // ----- analytics / data check -----
  analytics(days: number): Observable<AnalyticsReport> {
    return this.http.get<AnalyticsReport>(`${this.base}/analytics`, { params: { days } });
  }
  integrity(): Observable<IntegrityReport> {
    return this.http.get<IntegrityReport>(`${this.base}/integrity`);
  }
  fixIntegrity(kind: string, id: string): Observable<unknown> {
    return this.http.post(`${this.base}/integrity/fix`, { kind, id });
  }

  // ----- sessions -----
  sessions(): Observable<ActiveSession[]> {
    return this.http.get<ActiveSession[]>(`${this.base}/sessions`);
  }

  endSession(id: string): Observable<unknown> {
    return this.http.delete(`${this.base}/sessions/${encodeURIComponent(id)}`);
  }

  signOutUser(userId: string): Observable<unknown> {
    return this.http.post(`${this.base}/users/${userId}/sign-out`, {});
  }

  // ----- backups -----
  backups(): Observable<BackupList> {
    return this.http.get<BackupList>(`${this.base}/backups`);
  }

  backupNow(): Observable<BackupRequest> {
    return this.http.post<BackupRequest>(`${this.base}/backups`, {});
  }

  verifyBackup(stamp: string): Observable<{ ok: boolean; message: string }> {
    return this.http.post<{ ok: boolean; message: string }>(`${this.base}/backups/${stamp}/verify`, {});
  }

  restore(stamp: string, parts: string[], dryRun: boolean, confirm: string): Observable<BackupRequest> {
    return this.http.post<BackupRequest>(`${this.base}/backups/${stamp}/restore`, { parts, dryRun, confirm });
  }

  backupFile(stamp: string, file: string): Observable<Blob> {
    return this.http.get(`${this.base}/backups/${stamp}/files/${file}`, { responseType: 'blob' });
  }

  // ----- storage -----
  storage(): Observable<StorageReport> {
    return this.http.get<StorageReport>(`${this.base}/storage`);
  }

  setRetention(r: RetentionSettings): Observable<RetentionSettings> {
    return this.http.put<RetentionSettings>(`${this.base}/storage/retention`, r);
  }

  cleanup(): Observable<CleanupResult> {
    return this.http.post<CleanupResult>(`${this.base}/storage/cleanup`, {});
  }

  accounts(q: string, page: number, pageSize = 25): Observable<Page<AdminAccount>> {
    let params = new HttpParams().set('page', page).set('pageSize', pageSize);
    if (q) params = params.set('q', q);
    return this.http.get<Page<AdminAccount>>(`${this.base}/accounts`, { params });
  }

  setUserStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): Observable<unknown> {
    return this.http.put(`${this.base}/users/${userId}/status`, { status });
  }

  setQuota(accountId: string, quotaMb: number | null): Observable<unknown> {
    return this.http.put(`${this.base}/accounts/${accountId}/quota`, { quotaMb });
  }

  deleteUser(userId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/users/${userId}`);
  }

  audit(filter: { q?: string; action?: string; accountId?: string }, page: number, pageSize = 50): Observable<Page<AuditEntry>> {
    let params = new HttpParams().set('page', page).set('pageSize', pageSize);
    for (const [k, v] of Object.entries(filter)) if (v) params = params.set(k, v);
    return this.http.get<Page<AuditEntry>>(`${this.base}/audit`, { params });
  }
}

export interface ActiveSession {
  id: string;
  userId: string;
  name: string;
  email: string;
  account: string | null;
  ip: string;
  startedAt: string;
  lastAccessAt: string;
  apps: string[];
  current: boolean;
}

export interface BackupInfo {
  stamp: string;
  takenAt: string;
  files: { name: string; bytes: number }[];
  totalBytes: number;
  parts: { db: boolean; geoserver: boolean; storage: boolean; keycloak: boolean };
  commit: string | null;
  accounts: number | null;
}

export interface BackupRequest {
  id: string;
  action: 'backup' | 'restore';
  stamp?: string;
  parts?: string;
  dryRun?: boolean;
  requestedAt: string;
  requestedBy: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  message: string | null;
  updatedAt?: string;
}

export interface BackupList {
  backups: BackupInfo[];
  inProgress: boolean;
  requests: BackupRequest[];
}

export interface RetentionSettings {
  tempDays: number;
  georefDays: number;
  cacheDays: number;
  publishedOriginalsDays: number;
  auditDays: number;
}

export interface CleanupResult {
  at: string;
  by: string;
  freedBytes: number;
  removed: { temp: number; georef: number; cache: number; originals: number; auditRows: number };
}

export interface StorageReport {
  categories: Record<string, { bytes: number; files: number }>;
  database: { bytes: number; largestTables: { table: string; layer: string | null; bytes: number }[] };
  backups: { bytes: number; files: number };
  retention: RetentionSettings;
  lastCleanup: CleanupResult | null;
}

export interface PlatformUser {
  id: string;
  fullName: string;
  email: string;
  status: 'ACTIVE' | 'DISABLED';
  isPlatformAdmin: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  emailVerified: boolean | null;
  account: { id: string; name: string } | null;
}

export interface HealthReport {
  checkedAt: string;
  services: { name: string; ok: boolean; detail: string; ms: number }[];
  system: {
    cpus: number;
    load: number[];
    memory: { total: number; available: number };
    swap: { total: number; free: number };
    disk: { total: number; free: number } | null;
    uptimeSeconds: number;
  };
  geoserverRestarts7d: number;
}

export interface JobsOverview {
  running: { id: string; tool: string; status: string; stage: string; progress?: number; userEmail: string | null; cancellable: boolean; elapsedMs: number }[];
  recent: { id: string; tool: string; status: string; summary: string | null; layerName: string | null; createdAt: string; finishedAt: string | null; userEmail: string | null }[];
  schedules: { name: string; when: string; lastRun: string | null; lastResult: string | null; nextRun: string | null }[];
}

export interface LogEntry {
  at: string;
  level: string;
  context: string;
  message: string;
}

export interface SecuritySettings {
  minLength: number;
  digits: number;
  upperCase: number;
  specialChars: number;
  notUsername: boolean;
  expireDays: number;
  bruteForce: boolean;
  failures: number;
  lockMinutes: number;
  sessionIdleMinutes: number;
  requireTwoFactor: boolean;
}

export interface SecurityReport {
  canManageRealm: boolean;
  policy: { minLength: number; digits: number; upperCase: number; specialChars: number; notUsername: boolean; expireDays: number };
  bruteForce: { enabled: boolean; failures: number; lockMinutes: number };
  sessionIdleMinutes: number;
  requireTwoFactor: boolean;
  apiKeys: { id: string; name: string; prefix: string; account: string; createdAt: string; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null }[];
  shareLinks: { id: string; title: string; account: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; viewCount: number; lastViewedAt: string | null }[];
}

export interface EmailSettings {
  host: string;
  port: number;
  from: string;
  fromName: string;
  starttls: boolean;
  ssl: boolean;
  auth: boolean;
  user: string;
  password?: string;
  hasPassword?: boolean;
}

export interface Branding {
  platformName: string;
  tagline: string;
  loginMessage: string;
  primaryColor: string | null;
  hasLogo: boolean;
  logoVersion: number;
}

export interface Announcement {
  enabled: boolean;
  message: string;
  level: 'info' | 'warning' | 'critical';
  endsAt: string | null;
}

export interface Maintenance {
  enabled: boolean;
  message: string;
}

export interface ModuleSwitches {
  global: string[];
  perAccount: Record<string, string[]>;
}

export interface ModulesConfig {
  tools: { id: string; label: string; group: string }[];
  switches: ModuleSwitches;
  accounts: { id: string; name: string }[];
}

export interface AnalyticsReport {
  days: number;
  totals: { users: number; active7: number; active30: number; accounts: number; layers: number };
  activeUsers: { day: string; n: number }[];
  uploads: { day: string; n: number }[];
  layersCreated: { day: string; n: number }[];
  topTools: { tool: string; n: number }[];
}

export interface IntegrityReport {
  checkedAt: string;
  counts: { layers: number; geoserverLayers: number; tables: number };
  issues: { kind: string; id: string; title: string; detail: string; fixable: boolean }[];
}
