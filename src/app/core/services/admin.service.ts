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
