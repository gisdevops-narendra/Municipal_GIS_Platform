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
