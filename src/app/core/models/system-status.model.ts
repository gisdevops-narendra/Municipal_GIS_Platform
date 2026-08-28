/**
 * Shapes of `GET /api/system/status` and `GET /api/system/info` — the
 * read-only connectivity + version report behind Settings → System &
 * About. Mirrors `backend/src/system/system.service.ts`.
 */

export type ComponentState = 'up' | 'down';

export interface ComponentStatus {
  status: ComponentState;
  /** Present when down (the error) or, for the API, a short note. */
  detail?: string;
  /** Reported version string, when the component exposes one. */
  version?: string;
  latencyMs?: number;
}

export interface SystemStatus {
  checkedAt: string;
  api: ComponentStatus;
  database: ComponentStatus;
  postgis: ComponentStatus;
  geoserver: ComponentStatus;
}

export interface SystemInfo {
  apiVersion: string;
  node: string;
  environment: string;
  startedAt: string;
}
