import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  CreateMunicipalityUserRequest,
  CreateMunicipalityUserResponse,
  MunicipalityUser,
  MunicipalityUserStatus,
  UpdateMunicipalityUserRequest
} from '../models/municipality-user.model';

export interface UserListFilters {
  departmentId?: string;
  status?: MunicipalityUserStatus;
  search?: string;
}

/** Talks to /api/users (municipality user management — distinct from
 *  CurrentUserService, which is the caller's own /api/me profile). Tenant
 *  scoping and MUNICIPALITY_OWNER enforcement happen entirely server-side. */
@Injectable({ providedIn: 'root' })
export class UserManagementService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/users`;

  list(filters: UserListFilters = {}): Observable<MunicipalityUser[]> {
    let params = new HttpParams();
    if (filters.departmentId) params = params.set('departmentId', filters.departmentId);
    if (filters.status) params = params.set('status', filters.status);
    if (filters.search) params = params.set('search', filters.search);
    return this.http.get<MunicipalityUser[]>(this.baseUrl, { params });
  }

  get(id: string): Observable<MunicipalityUser> {
    return this.http.get<MunicipalityUser>(`${this.baseUrl}/${id}`);
  }

  create(request: CreateMunicipalityUserRequest): Observable<CreateMunicipalityUserResponse> {
    return this.http.post<CreateMunicipalityUserResponse>(this.baseUrl, request);
  }

  update(id: string, request: UpdateMunicipalityUserRequest): Observable<MunicipalityUser> {
    return this.http.patch<MunicipalityUser>(`${this.baseUrl}/${id}`, request);
  }

  updateStatus(id: string, status: MunicipalityUserStatus): Observable<MunicipalityUser> {
    return this.http.patch<MunicipalityUser>(`${this.baseUrl}/${id}/status`, { status });
  }
}
