export type GisWorkspaceStatus = 'PROVISIONING' | 'ACTIVE' | 'PROVISIONING_FAILED';

/** Shape of GET/PATCH /api/gis/workspace — the caller's own municipality's
 *  permanent GIS workspace. There is exactly one per municipality; this
 *  endpoint never takes an id, so there is nothing for the client to
 *  parameterize away from its own tenant. */
export interface GisWorkspace {
  id: string;
  name: string;
  code: string;
  description: string | null;
  status: GisWorkspaceStatus;
  defaultCrs: string;
  displayCrs: string;
  /** System-controlled — never editable from the client. */
  geoserverWorkspace: string;
  createdAt: string;
  updatedAt: string;
}

/** Owner-editable fields only. No municipalityId/geoserverWorkspace/code —
 *  those are system-controlled (see backend UpdateGisWorkspaceDto). */
export interface UpdateGisWorkspaceRequest {
  name?: string;
  description?: string;
  defaultCrs?: string;
  displayCrs?: string;
}

export interface GeoServerHealth {
  status: 'UP';
  version?: string;
}
