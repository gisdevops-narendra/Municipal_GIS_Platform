import { AsyncLocalStorage } from 'async_hooks';

/** What the job's code sees (via AsyncLocalStorage) while it runs. */
export interface RasterJobContext {
  signal: AbortSignal;
  setStage(stage: string, cancellable?: boolean): void;
}

/** Set while a background job runs, so RasterService.runOp can report its
 *  stage and kill the GDAL process when the job is cancelled. */
export const rasterJobContext = new AsyncLocalStorage<RasterJobContext>();
