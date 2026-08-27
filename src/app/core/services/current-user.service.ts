import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CurrentUser } from '../models/current-user.model';

/**
 * Talks to GET /api/me — the authenticated application user (and their
 * municipality), resolved server-side from the validated Keycloak token.
 * The bearer-token interceptor (see bearer-token.interceptor.config.ts)
 * attaches the Authorization header automatically for this URL.
 */
@Injectable({ providedIn: 'root' })
export class CurrentUserService {
  private readonly http = inject(HttpClient);

  getMe(): Observable<CurrentUser> {
    return this.http.get<CurrentUser>(`${environment.apiUrl}/me`);
  }
}
