import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  CreateModuleRequest,
  DepartmentModuleGrants,
  ModuleCatalogEntry,
  UserModuleGrants
} from '../models/module-access.model';

/** Talks to /api/module-access/*. Every write is a full replace of the
 *  target's explicit grant list — the backend re-derives the effective
 *  (ancestor- and default-expanded) set itself; this service never
 *  computes or trusts an effective set the backend didn't return. */
@Injectable({ providedIn: 'root' })
export class ModuleAccessService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/module-access`;

  getCatalog(): Observable<ModuleCatalogEntry[]> {
    return this.http.get<ModuleCatalogEntry[]>(`${this.baseUrl}/catalog`);
  }

  /** Owner-only — adds one new module to the global catalog. */
  createModule(request: CreateModuleRequest): Observable<ModuleCatalogEntry> {
    return this.http.post<ModuleCatalogEntry>(`${this.baseUrl}/catalog`, request);
  }

  /** The caller's own resolved module set — what the live /gis workspace
   *  gates its tool rail on. */
  getMyModuleIds(): Observable<{ moduleIds: number[] }> {
    return this.http.get<{ moduleIds: number[] }>(`${this.baseUrl}/me`);
  }

  getDepartmentGrants(departmentId: string): Observable<DepartmentModuleGrants> {
    return this.http.get<DepartmentModuleGrants>(`${this.baseUrl}/departments/${departmentId}`);
  }

  setDepartmentGrants(departmentId: string, moduleIds: number[]): Observable<DepartmentModuleGrants> {
    return this.http.put<DepartmentModuleGrants>(`${this.baseUrl}/departments/${departmentId}`, { moduleIds });
  }

  getUserGrants(userId: string): Observable<UserModuleGrants> {
    return this.http.get<UserModuleGrants>(`${this.baseUrl}/users/${userId}`);
  }

  setUserGrants(userId: string, moduleIds: number[]): Observable<UserModuleGrants> {
    return this.http.put<UserModuleGrants>(`${this.baseUrl}/users/${userId}`, { moduleIds });
  }
}
