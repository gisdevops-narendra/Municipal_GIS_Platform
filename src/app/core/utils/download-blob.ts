import { HttpErrorResponse } from '@angular/common/http';

/** Saves `blob` as a file download named `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** The API's `{ message }` from a failed `responseType: 'blob'` request —
 *  Angular hands the error body back as a Blob, not parsed JSON. */
export async function blobErrorMessage(error: HttpErrorResponse, fallback: string): Promise<string> {
  try {
    const body: unknown = error.error instanceof Blob ? JSON.parse(await error.error.text()) : error.error;
    const message = (body as { message?: unknown } | null)?.message;
    return typeof message === 'string' && message ? message : fallback;
  } catch {
    return fallback;
  }
}
