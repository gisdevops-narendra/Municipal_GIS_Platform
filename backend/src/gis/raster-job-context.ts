import { AsyncLocalStorage } from 'async_hooks';

/** What the job's code sees (via AsyncLocalStorage) while it runs. */
export interface RasterJobContext {
  signal: AbortSignal;
  setStage(stage: string, cancellable?: boolean): void;
  /** Owner's choice of department for the layers the job creates. */
  outputDepartmentId?: string;
  /** Names of the input layers, collected as they are resolved. */
  sources: string[];
  /** Provenance text for the new layer's description. */
  describe(): string;
}

/** Set while a background job runs, so RasterService.runOp can report its
 *  stage and kill the GDAL process when the job is cancelled. */
export const rasterJobContext = new AsyncLocalStorage<RasterJobContext>();
