import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';

/** Body for POST /api/municipalities/register (account sign-up). No role
 *  or keycloakUserId — the backend assigns those. */
export interface RegisterAccountRequest {
  fullName: string;
  email: string;
  password: string;
  mobileNumber?: string;
}

export interface RegisterAccountResponse {
  user: { id: string; fullName: string; email: string };
  gisWorkspace: { id: string; status: string };
}

@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly http = inject(HttpClient);

  register(request: RegisterAccountRequest): Observable<RegisterAccountResponse> {
    return this.http.post<RegisterAccountResponse>(`${environment.apiUrl}/municipalities/register`, request);
  }
}
