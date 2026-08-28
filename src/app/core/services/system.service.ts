import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { SystemInfo, SystemStatus } from '../models/system-status.model';

/**
 * Talks to `GET /api/system/*` — platform connectivity + version info for
 * the Settings → System & About sections. Not tenant-scoped: connectivity
 * is a platform fact. Every check is defensive server-side, so `status()`
 * always resolves (a down dependency is a normal payload, not an error).
 */
@Injectable({ providedIn: 'root' })
export class SystemService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/system`;

  status(): Observable<SystemStatus> {
    return this.http.get<SystemStatus>(`${this.baseUrl}/status`);
  }

  info(): Observable<SystemInfo> {
    return this.http.get<SystemInfo>(`${this.baseUrl}/info`);
  }
}
