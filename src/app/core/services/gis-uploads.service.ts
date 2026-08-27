import { HttpClient, HttpEventType } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { environment } from '../../../environments/environment';
import {
  CreateGisUploadRequest,
  GisUpload,
  GisUploadPage,
  GisUploadPreview
} from '../models/gis-upload.model';

/** One event emitted while an upload is in flight — either real HTTP
 *  upload progress (Task 7 §24: "Use actual HTTP upload progress where
 *  possible", never faked) or the final created GisUpload once the
 *  server has responded (which, per this task's synchronous design,
 *  already reflects the outcome of validation too). */
export type UploadProgressEvent =
  | { type: 'progress'; percent: number }
  | { type: 'done'; upload: GisUpload };

/** Talks to /api/gis/uploads*. Tenant scoping, department/ownership
 *  authorization, and every workflow-state transition are enforced
 *  entirely server-side — this service never replicates that logic. */
@Injectable({ providedIn: 'root' })
export class GisUploadsService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiUrl}/gis/uploads`;

  /** Multipart upload with real progress events, via HttpClient's own
   *  reportProgress — never a simulated/timer-based progress bar. */
  create(file: File, request: CreateGisUploadRequest): Observable<UploadProgressEvent> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('layerName', request.layerName);
    if (request.description) formData.append('description', request.description);
    if (request.departmentId) formData.append('departmentId', request.departmentId);
    formData.append('ownershipType', request.ownershipType);
    if (request.sourceCrs) formData.append('sourceCrs', request.sourceCrs);
    if (request.latitudeField) formData.append('latitudeField', request.latitudeField);
    if (request.longitudeField) formData.append('longitudeField', request.longitudeField);
    if (request.xField) formData.append('xField', request.xField);
    if (request.yField) formData.append('yField', request.yField);

    return this.http
      .post<GisUpload>(this.baseUrl, formData, {
        reportProgress: true,
        observe: 'events'
      })
      .pipe(
        filter(
          (event) =>
            event.type === HttpEventType.UploadProgress || event.type === HttpEventType.Response
        ),
        map((event): UploadProgressEvent => {
          if (event.type === HttpEventType.UploadProgress) {
            const percent = event.total ? Math.round((100 * event.loaded) / event.total) : 0;
            return { type: 'progress', percent };
          }
          if (event.type === HttpEventType.Response) {
            return { type: 'done', upload: event.body as GisUpload };
          }
          // Unreachable: filter() above only lets UploadProgress/Response through.
          throw new Error('Unexpected HTTP event during upload.');
        })
      );
  }

  list(page = 1, pageSize = 20): Observable<GisUploadPage> {
    return this.http.get<GisUploadPage>(this.baseUrl, {
      params: { page: String(page), pageSize: String(pageSize) }
    });
  }

  getById(id: string): Observable<GisUpload> {
    return this.http.get<GisUpload>(`${this.baseUrl}/${id}`);
  }

  validate(id: string): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/${id}/validate`, {});
  }

  preview(id: string): Observable<GisUploadPreview> {
    return this.http.get<GisUploadPreview>(`${this.baseUrl}/${id}/preview`);
  }

  submitForReview(id: string): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/${id}/submit-review`, {});
  }

  approve(id: string): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/${id}/approve`, {});
  }

  reject(id: string, rejectionReason: string): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/${id}/reject`, { rejectionReason });
  }

  publish(id: string): Observable<GisUpload> {
    return this.http.post<GisUpload>(`${this.baseUrl}/${id}/publish`, {});
  }
}
