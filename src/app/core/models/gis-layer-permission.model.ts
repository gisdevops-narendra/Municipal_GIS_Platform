import { ManagedRole } from './municipality-user.model';
import { GisLayer } from './gis-layer.model';

/** The six Task 8 permissions — deliberately no FEATURE_EDIT. */
export type GisPermission = 'VIEW' | 'UPLOAD' | 'APPROVE' | 'PUBLISH' | 'EXPORT' | 'MANAGE';

export const GIS_PERMISSIONS: GisPermission[] = ['VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE'];

export interface GisLayerPermissionGrant {
  departmentId: string;
  departmentName: string;
  /** Every granted permission for each role, in this department, on this
   *  layer — an empty array means no grants at all for that role. */
  grants: Record<ManagedRole, GisPermission[]>;
}

/** Shape of GET /api/gis/layers/:id/permissions — every department that
 *  currently has at least one grant on this layer (which always includes
 *  the layer's own owning department, seeded automatically at publish
 *  time — Task 8 §4), plus the full department list so the Owner can
 *  grant a department that has none yet (Task 8 §5's cross-department
 *  case). */
export interface GisLayerPermissionMatrix {
  layer: GisLayer;
  departments: { id: string; name: string }[];
  grants: GisLayerPermissionGrant[];
}
