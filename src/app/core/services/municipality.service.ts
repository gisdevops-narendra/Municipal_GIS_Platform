import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { RegisterMunicipalityRequest, RegisterMunicipalityResponse } from '../models/register-municipality.model';

/**
 * Talks to the NestJS municipality registration API. This is the only
 * place in the app that knows the registration endpoint's URL/shape —
 * components go through this service instead of using HttpClient directly.
 */
@Injectable({ providedIn: 'root' })
export class MunicipalityService {
  private readonly http = inject(HttpClient);

  register(request: RegisterMunicipalityRequest): Observable<RegisterMunicipalityResponse> {
    return this.http.post<RegisterMunicipalityResponse>(`${environment.apiUrl}/municipalities/register`, request);
  }
}
