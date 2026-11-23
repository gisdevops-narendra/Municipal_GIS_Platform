import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import type { SavedMapState } from './map.service';

export interface SavedMap {
  id: string;
  name: string;
  description: string | null;
  state: SavedMapState;
  shared: boolean;
  /** created by the current user (only they can change / delete it) */
  mine: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Saved maps (backend: SavedMapsController). */
@Injectable({ providedIn: 'root' })
export class SavedMapsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/saved-maps`;

  list(): Observable<SavedMap[]> {
    return this.http.get<SavedMap[]>(this.baseUrl);
  }

  create(name: string, state: SavedMapState, shared: boolean): Observable<SavedMap> {
    return this.http.post<SavedMap>(this.baseUrl, { name, state, shared });
  }

  update(map: SavedMap, changes: Partial<Pick<SavedMap, 'name' | 'state' | 'shared'>>): Observable<SavedMap> {
    return this.http.put<SavedMap>(`${this.baseUrl}/${map.id}`, {
      name: changes.name ?? map.name,
      state: changes.state ?? map.state,
      shared: changes.shared ?? map.shared
    });
  }

  remove(id: string): Observable<{ success: true }> {
    return this.http.delete<{ success: true }>(`${this.baseUrl}/${id}`);
  }
}
