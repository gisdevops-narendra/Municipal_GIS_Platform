import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CreateDepartmentRequest, Department, UpdateDepartmentRequest } from '../models/department.model';

/** Talks to /api/departments. Tenant scoping and MUNICIPALITY_OWNER
 *  enforcement happen entirely server-side — this service does not (and
 *  must not) attempt to replicate that logic on the client. */
@Injectable({ providedIn: 'root' })
export class DepartmentService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/departments`;

  list(): Observable<Department[]> {
    return this.http.get<Department[]>(this.baseUrl);
  }

  get(id: string): Observable<Department> {
    return this.http.get<Department>(`${this.baseUrl}/${id}`);
  }

  create(request: CreateDepartmentRequest): Observable<Department> {
    return this.http.post<Department>(this.baseUrl, request);
  }

  update(id: string, request: UpdateDepartmentRequest): Observable<Department> {
    return this.http.patch<Department>(`${this.baseUrl}/${id}`, request);
  }

  remove(id: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/${id}`);
  }
}
