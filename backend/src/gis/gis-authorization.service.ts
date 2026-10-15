import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import {
  GisLayerOwnershipType,
  GisPermission,
  SystemRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';

export const ALL_PERMISSIONS: GisPermission[] = [
  'VIEW',
  'UPLOAD',
  'APPROVE',
  'PUBLISH',
  'EXPORT',
  'MANAGE',
];

/** Task 8 §4 defaults — materialized as real, editable GISLayerPermission
 *  rows the moment a DEPARTMENT layer's owning department is known (see
 *  ensureDefaultPermissions), and also used as the *virtual* fallback for
 *  a layer that doesn't exist in the database yet (a brand-new upload
 *  targeting a never-before-published layer code) — see resolvePermissions
 *  in GisUploadsService. */
const DEFAULT_PERMISSIONS: Record<
  'DEPARTMENT_HEAD' | 'DEPARTMENT_USER',
  GisPermission[]
> = {
  // The Head reviews/approves uploads, publishes and manages their own
  // department's data.
  DEPARTMENT_HEAD: ['VIEW', 'UPLOAD', 'APPROVE', 'PUBLISH', 'EXPORT', 'MANAGE'],
  // The User only views/visualizes GIS data — see getPermissions.
  DEPARTMENT_USER: ['VIEW'],
};

export interface LayerLike {
  id: string;
  ownershipType: GisLayerOwnershipType;
  departmentId: string | null;
}

/**
 * Centralized, single source of truth for "may this user do X to this GIS
 * layer" (Task 8 §10) — every controller/service that needs a GIS
 * permission decision goes through here, never re-implements the logic
 * itself. Two closely related but distinct things live here:
 *
 * 1. Real, per-layer grants (`GISLayerPermission` rows) — what actually
 *    governs an EXISTING published layer. A department layer's owning
 *    department's Head/User get their §4 defaults seeded as ordinary rows
 *    the moment the layer is first published (`ensureDefaultPermissions`),
 *    which is what makes them editable/revocable by the Owner. A
 *    cross-department grant (§5) is just another row with a *different*
 *    `departmentId` than the layer's own.
 * 2. Virtual defaults for a layer that doesn't exist in the database yet
 *    (`getDefaultPermissions`) — used only while a brand-new upload is
 *    still working its way toward its first publish, before there is any
 *    GISLayer row (and therefore no GISLayerPermission rows) to consult.
 *
 * MUNICIPALITY_OWNER's access is unconditional and never stored as rows —
 * enforced directly in code here, the same way it always has been
 * throughout Tasks 3-7.
 */
@Injectable()
export class GisAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Real permission set for an EXISTING layer. */
  async getPermissions(
    appUser: AppUser,
    layer: LayerLike,
  ): Promise<Set<GisPermission>> {
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      return new Set(ALL_PERMISSIONS);
    }
    // Every municipality member may view/visualize all of the
    // municipality's GIS data. Beyond that, a Department User is strictly
    // view-only (never widened by grant rows), and only the Owner manages
    // canonical layers (Task 7 §12).
    const permissions = new Set<GisPermission>(['VIEW']);
    if (
      appUser.systemRole !== 'DEPARTMENT_HEAD' ||
      layer.ownershipType === 'CANONICAL' ||
      !appUser.departmentId
    ) {
      return permissions;
    }
    const grants = await this.prisma.gISLayerPermission.findMany({
      where: {
        gisLayerId: layer.id,
        departmentId: appUser.departmentId,
        role: appUser.systemRole,
      },
      select: { permission: true },
    });
    for (const grant of grants) {
      permissions.add(grant.permission);
    }
    return permissions;
  }

  /** Virtual permission set for a DEPARTMENT-ownership layer that has no
   *  GISLayer row yet — a brand-new upload's first-ever version. Never
   *  consults the database; purely the §4 role defaults, scoped to the
   *  upload's own target department. A cross-department grant cannot
   *  exist yet for a layer that has never been published, by definition —
   *  so unlike getPermissions, this never returns anything for a
   *  different department than the target one. */
  getDefaultPermissions(
    appUser: AppUser,
    ownershipType: GisLayerOwnershipType,
    departmentId: string | null,
  ): Set<GisPermission> {
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      return new Set(ALL_PERMISSIONS);
    }
    if (ownershipType === 'CANONICAL') {
      return new Set();
    }
    if (
      !appUser.departmentId ||
      !departmentId ||
      appUser.departmentId !== departmentId
    ) {
      return new Set();
    }
    if (
      appUser.systemRole === 'DEPARTMENT_HEAD' ||
      appUser.systemRole === 'DEPARTMENT_USER'
    ) {
      return new Set(DEFAULT_PERMISSIONS[appUser.systemRole]);
    }
    return new Set();
  }

  async canView(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('VIEW');
  }

  async canUpload(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('UPLOAD');
  }

  async canApprove(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('APPROVE');
  }

  async canPublish(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('PUBLISH');
  }

  async canExport(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('EXPORT');
  }

  async canManage(appUser: AppUser, layer: LayerLike): Promise<boolean> {
    return (await this.getPermissions(appUser, layer)).has('MANAGE');
  }

  /** Bulk VIEW filter for a layer list. Every municipality member may
   *  view all of the municipality's GIS data (see getPermissions), so this
   *  is currently a pass-through — callers still route through it so the
   *  rule stays in one place (Task 8 §8). Tenant scoping is the caller's
   *  job: `layers` must already belong to the caller's municipality. */
  filterViewable<T extends LayerLike>(
    _appUser: AppUser,
    layers: T[],
  ): Promise<T[]> {
    return Promise.resolve(layers);
  }

  /** Seeds the §4 default permission rows for a DEPARTMENT layer's own
   *  owning department — called once, right after a department layer is
   *  first created (GisUploadsService.publish). Idempotent (upsert);
   *  never overwrites a row the Owner has since changed (only creates
   *  what's missing). No-op for CANONICAL layers or a layer with no
   *  department. */
  async ensureDefaultPermissions(
    gisLayerId: string,
    departmentId: string,
  ): Promise<void> {
    const rows: { role: SystemRole; permission: GisPermission }[] = [
      ...DEFAULT_PERMISSIONS.DEPARTMENT_HEAD.map((permission) => ({
        role: 'DEPARTMENT_HEAD' as const,
        permission,
      })),
      ...DEFAULT_PERMISSIONS.DEPARTMENT_USER.map((permission) => ({
        role: 'DEPARTMENT_USER' as const,
        permission,
      })),
    ];
    for (const row of rows) {
      await this.prisma.gISLayerPermission.upsert({
        where: {
          gisLayerId_departmentId_role_permission: {
            gisLayerId,
            departmentId,
            role: row.role,
            permission: row.permission,
          },
        },
        create: {
          gisLayerId,
          departmentId,
          role: row.role,
          permission: row.permission,
        },
        update: {},
      });
    }
  }

  /** Full permission matrix for the layer permissions UI (Task 8 §7) —
   *  every (role, permission) cell, department-scoped to the layer's own
   *  department plus any department that has at least one grant. */
  async listGrants(gisLayerId: string) {
    return this.prisma.gISLayerPermission.findMany({
      where: { gisLayerId },
      include: { department: { select: { id: true, name: true } } },
      orderBy: [
        { departmentId: 'asc' },
        { role: 'asc' },
        { permission: 'asc' },
      ],
    });
  }

  /** Owner-only mutation (enforced by the caller via canManage), used by
   *  the permission management UI to grant or revoke one cell. Never
   *  allows an actor to change the row that governs their own
   *  (role, department) pair — Task 8 §7: "Never allow a user to grant
   *  themselves permissions." Idempotent either direction. */
  async setGrant(
    actor: AppUser,
    gisLayerId: string,
    departmentId: string,
    role: 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER',
    permission: GisPermission,
    granted: boolean,
  ): Promise<void> {
    if (actor.departmentId === departmentId && actor.systemRole === role) {
      throw new ForbiddenException(
        'You cannot change permissions for your own role.',
      );
    }
    if (granted && role === 'DEPARTMENT_USER' && permission !== 'VIEW') {
      throw new BadRequestException(
        'Department Users are view-only and cannot be granted other permissions.',
      );
    }

    if (granted) {
      await this.prisma.gISLayerPermission.upsert({
        where: {
          gisLayerId_departmentId_role_permission: {
            gisLayerId,
            departmentId,
            role,
            permission,
          },
        },
        create: { gisLayerId, departmentId, role, permission },
        update: {},
      });
    } else {
      await this.prisma.gISLayerPermission.deleteMany({
        where: { gisLayerId, departmentId, role, permission },
      });
    }
  }
}
