import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CurrentUser } from '../models/current-user.model';

/** The two fields a user may change about their own profile
 *  (`PATCH /api/me`). Everything else is administrative. */
export interface UpdateMeRequest {
  fullName?: string;
  mobileNumber?: string;
}

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

  /** Emits the updated user after a successful profile edit, so screens
   *  kept alive across navigation (e.g. every page's header) can refresh. */
  readonly updated = signal<CurrentUser | null>(null);

  /** Self-service profile edit. Returns the same shape as `getMe()`. */
  updateMe(request: UpdateMeRequest): Observable<CurrentUser> {
    return this.http
      .patch<CurrentUser>(`${environment.apiUrl}/me`, request)
      .pipe(tap((user) => this.updated.set(user)));
  }
}
