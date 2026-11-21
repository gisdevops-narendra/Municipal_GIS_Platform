import { Injectable } from '@nestjs/common';
import type { AppUser } from '../auth/types/app-user.type';

/** Layer actions the app checks before acting. */
export type GisPermission = 'VIEW' | 'UPLOAD' | 'APPROVE' | 'PUBLISH' | 'EXPORT' | 'MANAGE';

export const ALL_PERMISSIONS: GisPermission[] = ['VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE'];

export interface LayerLike {
  id: string;
}

/**
 * Single place that answers "may this user do X to this GIS layer".
 *
 * Departments, roles and per-layer permission rows were removed: every
 * account owns its own workspace, so a signed-in, active user may do
 * everything with the layers of their own account. Tenant isolation is NOT
 * decided here — callers only ever pass layers already scoped to the
 * caller's account (findLayerInMunicipality etc.). Callers keep routing
 * through this service so a future sharing feature has one place to hook in.
 */
@Injectable()
export class GisAuthorizationService {
  getPermissions(appUser: AppUser, _layer?: LayerLike): Promise<Set<GisPermission>> {
    return Promise.resolve(this.permissionsFor(appUser));
  }

  /** Same answer for a layer that doesn't exist yet (first upload). */
  getDefaultPermissions(appUser: AppUser): Set<GisPermission> {
    return this.permissionsFor(appUser);
  }

  canView(appUser: AppUser, layer?: LayerLike): Promise<boolean> {
    return this.has(appUser, 'VIEW', layer);
  }

  canUpload(appUser: AppUser, layer?: LayerLike): Promise<boolean> {
    return this.has(appUser, 'UPLOAD', layer);
  }

  canExport(appUser: AppUser, layer?: LayerLike): Promise<boolean> {
    return this.has(appUser, 'EXPORT', layer);
  }

  canManage(appUser: AppUser, layer?: LayerLike): Promise<boolean> {
    return this.has(appUser, 'MANAGE', layer);
  }

  /** Every layer of the caller's own account is viewable. */
  filterViewable<T extends LayerLike>(_appUser: AppUser, layers: T[]): Promise<T[]> {
    return Promise.resolve(layers);
  }

  private async has(appUser: AppUser, permission: GisPermission, layer?: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has(permission);
  }

  private permissionsFor(appUser: AppUser): Set<GisPermission> {
    return new Set(appUser.status === 'ACTIVE' ? ALL_PERMISSIONS : []);
  }
}
