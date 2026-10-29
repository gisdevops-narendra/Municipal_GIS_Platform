import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { environment } from '../../../environments/environment';
import {
  ExternalDataset,
  ExternalDbConnection,
  ExternalDbImportRequest,
  ExternalPreview
} from '../models/external-db.model';
import { GisUpload } from '../models/gis-upload.model';

/** Talks to /api/gis/external-db/* — import GIS data from the user's own
 *  database. Connection details go in POST bodies only. */
@Injectable({ providedIn: 'root' })
export class ExternalDbService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/external-db`;

  test(connection: ExternalDbConnection): Observable<{ message: string; datasetCount: number; spatialCount: number }> {
    return this.http.post<{ message: string; datasetCount: number; spatialCount: number }>(`${this.baseUrl}/test`, { connection });
  }

  datasets(connection: ExternalDbConnection): Observable<ExternalDataset[]> {
    return this.http.post<ExternalDataset[]>(`${this.baseUrl}/datasets`, { connection });
  }

  preview(connection: ExternalDbConnection, dataset: string): Observable<ExternalPreview> {
    return this.http.post<ExternalPreview>(`${this.baseUrl}/preview`, { connection, dataset });
  }

  /** Creates an upload from the dataset (already validated, like a file). */
  import(request: ExternalDbImportRequest): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/import`, request);
  }
}
