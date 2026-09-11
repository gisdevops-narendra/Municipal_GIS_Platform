import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AppUser } from '../auth/types/app-user.type';
import type { CreateModuleDto } from './dto/create-module.dto';

export interface ModuleCatalogEntry {
  id: number;
  name: string;
  parentId: number | null;
  nodePath: string | null;
  defaultModule: boolean | null;
  displayPriority: number | null;
  type: string | null;
}

interface ModuleForResolve {
  id: number;
  nodePath: string | null;
}

/** The subset of AppUser this service actually needs to resolve a module
 *  set — lets getEffectiveModuleIdsForAppUser be called both with a real
 *  AppUser (the authenticated caller) and with a plain user row fetched
 *  from Prisma (a grant target), without constructing a fake AppUser. */
type ResolvableUser = Pick<AppUser, 'id' | 'departmentId' | 'systemRole'>;

/**
 * Hierarchical Module Access. A Municipality Owner has every active
 * module unconditionally; the Owner grants a subset to a Department,
 * which becomes that Department's Head's own access; a Department Head
 * grants a further subset of THAT to their own Department Users — and
 * the backend, not just the UI, refuses to let a Head grant a module
 * they don't themselves have (see setUserGrants). Modules with
 * `defaultModule: true` (Pan/Zoom/Basemap/Measure/...) are always
 * included for everyone regardless of any grant, and granting (or
 * defaulting) a module always implies access to its ancestors too, via
 * Module.nodePath (see resolveModuleIds — the schema doc explains why
 * nodePath, not parentId, is the hierarchy source of truth here).
 */
@Injectable()
export class ModuleAccessService {
  constructor(private readonly prisma: PrismaService) {}

  async getCatalog(): Promise<ModuleCatalogEntry[]> {
    const modules = await this.prisma.module.findMany({
      where: { isActive: true },
      orderBy: [{ displayPriority: 'asc' }, { name: 'asc' }],
    });
    return modules.map((m) => ({
      id: m.id,
      name: m.name,
      parentId: m.parentId,
      nodePath: m.nodePath,
      defaultModule: m.defaultModule,
      displayPriority: m.displayPriority,
      type: m.type,
    }));
  }

  /**
   * Owner-only (enforced by the controller decorator, matching
   * setDepartmentGrants) — adds one new module to the global catalog.
   * `nodePath` is derived here, never supplied by the caller: a child of
   * an existing module gets `${parent.nodePath}.${newId}` so it is
   * immediately picked up by every ancestor-walk in this file
   * (resolveModuleIds); a top-level module (or one nested under a parent
   * that itself has no nodePath — a handful of legacy seed rows don't,
   * see the Module schema doc) just gets its own id as a single-segment
   * path. The row is created first (so the database assigns the id via
   * `modules_module_id_seq`), then patched with the nodePath that
   * depends on that id — two statements, not one, since nodePath needs
   * an id that doesn't exist yet at insert time.
   */
  async createModule(dto: CreateModuleDto): Promise<ModuleCatalogEntry> {
    let parentNodePath: string | null = null;
    if (dto.parentId !== undefined) {
      const parent = await this.prisma.module.findFirst({
        where: { id: dto.parentId, isActive: true },
        select: { nodePath: true },
      });
      if (!parent) {
        throw new BadRequestException(
          `Parent module ${dto.parentId} not found or inactive.`,
        );
      }
      parentNodePath = parent.nodePath;
    }

    const created = await this.prisma.module.create({
      data: {
        name: dto.name.trim(),
        parentId: dto.parentId ?? null,
        type: dto.type ?? null,
        defaultModule: dto.defaultModule ?? false,
        displayPriority: dto.displayPriority ?? null,
        isActive: true,
      },
    });

    const nodePath = parentNodePath
      ? `${parentNodePath}.${created.id}`
      : `${created.id}`;
    const module = await this.prisma.module.update({
      where: { id: created.id },
      data: { nodePath },
    });

    return {
      id: module.id,
      name: module.name,
      parentId: module.parentId,
      nodePath: module.nodePath,
      defaultModule: module.defaultModule,
      displayPriority: module.displayPriority,
      type: module.type,
    };
  }

  /** Every active module id that is a default (always-on) module — the
   *  floor every resolved set starts from. */
  private async getDefaultModules(): Promise<ModuleForResolve[]> {
    return this.prisma.module.findMany({
      where: { isActive: true, defaultModule: true },
      select: { id: true, nodePath: true },
    });
  }

  /** Expands a set of explicitly-granted module ids into the full
   *  effective set: the modules themselves, every one of their
   *  ancestors, and every default module (+ its own ancestors), unioned
   *  together. Unknown/inactive ids in `explicitIds` are silently
   *  dropped (callers that must reject them validate separately — see
   *  assertModuleIdsExist — this method is also used for read paths
   *  where stale ids should just not count, not error). */
  async resolveModuleIds(explicitIds: number[]): Promise<Set<number>> {
    const defaults = await this.getDefaultModules();
    const explicit =
      explicitIds.length > 0
        ? await this.prisma.module.findMany({
            where: { id: { in: explicitIds }, isActive: true },
            select: { id: true, nodePath: true },
          })
        : [];

    const result = new Set<number>();
    const addWithAncestors = (m: ModuleForResolve) => {
      result.add(m.id);
      if (m.nodePath) {
        for (const segment of m.nodePath.split('.')) {
          const ancestorId = Number(segment);
          if (Number.isInteger(ancestorId)) {
            result.add(ancestorId);
          }
        }
      }
    };
    defaults.forEach(addWithAncestors);
    explicit.forEach(addWithAncestors);
    return result;
  }

  async getAllActiveModuleIds(): Promise<Set<number>> {
    const modules = await this.prisma.module.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    return new Set(modules.map((m) => m.id));
  }

  async getDepartmentExplicitModuleIds(
    departmentId: string,
  ): Promise<number[]> {
    const grants = await this.prisma.departmentModuleGrant.findMany({
      where: { departmentId },
      select: { moduleId: true },
    });
    return grants.map((g) => g.moduleId);
  }

  async getDepartmentEffectiveModuleIds(
    departmentId: string,
  ): Promise<Set<number>> {
    const explicit = await this.getDepartmentExplicitModuleIds(departmentId);
    return this.resolveModuleIds(explicit);
  }

  async getUserExplicitModuleIds(userId: string): Promise<number[]> {
    const grants = await this.prisma.userModuleGrant.findMany({
      where: { userId },
      select: { moduleId: true },
    });
    return grants.map((g) => g.moduleId);
  }

  /** The module set a given app user actually has — what the live /gis
   *  workspace gates its tool rail on (GET /module-access/me).
   *  MUNICIPALITY_OWNER: every active module, unconditionally.
   *  DEPARTMENT_HEAD: exactly their department's effective set (a
   *  Head's own access IS the department's grant — there is no separate
   *  per-Head grant). DEPARTMENT_USER: their own explicit grants,
   *  clamped to their department's *current* effective set (defence in
   *  depth: this makes "a User never has more than their department"
   *  hold continuously, self-healing if the department's own access is
   *  later reduced — not just checked once at grant time; see
   *  setUserGrants for the write-time check), expanded with
   *  ancestors/defaults. */
  async getEffectiveModuleIdsForAppUser(
    appUser: ResolvableUser,
  ): Promise<Set<number>> {
    if (appUser.systemRole === 'MUNICIPALITY_OWNER') {
      return this.getAllActiveModuleIds();
    }

    const deptSet = appUser.departmentId
      ? await this.getDepartmentEffectiveModuleIds(appUser.departmentId)
      : await this.resolveModuleIds([]);

    if (appUser.systemRole === 'DEPARTMENT_HEAD') {
      return deptSet;
    }

    const explicit = await this.getUserExplicitModuleIds(appUser.id);
    const clamped = explicit.filter((id) => deptSet.has(id));
    return this.resolveModuleIds(clamped);
  }

  // ---------------------------------------------------------------------
  // Department grants (Owner writes; Owner + the department's own Head
  // may read)
  // ---------------------------------------------------------------------

  async getDepartmentGrants(actor: AppUser, departmentId: string) {
    await this.assertCanViewDepartment(actor, departmentId);
    const explicitModuleIds =
      await this.getDepartmentExplicitModuleIds(departmentId);
    const effectiveModuleIds = await this.resolveModuleIds(explicitModuleIds);
    return {
      departmentId,
      explicitModuleIds,
      effectiveModuleIds: [...effectiveModuleIds],
    };
  }

  /** Owner-only — the Municipality Owner assigns a Department (and
   *  therefore its Head) a subset of the full catalog. Full replace,
   *  matching how the tree-checklist admin UI edits it. */
  async setDepartmentGrants(
    actor: AppUser,
    departmentId: string,
    moduleIds: number[],
  ) {
    await this.assertDepartmentInMunicipality(
      actor.municipalityId,
      departmentId,
    );
    await this.assertModuleIdsExist(moduleIds);

    await this.prisma.$transaction([
      this.prisma.departmentModuleGrant.deleteMany({
        where: { departmentId },
      }),
      this.prisma.departmentModuleGrant.createMany({
        data: moduleIds.map((moduleId) => ({
          departmentId,
          moduleId,
          grantedById: actor.id,
        })),
      }),
    ]);

    return this.getDepartmentGrants(actor, departmentId);
  }

  // ---------------------------------------------------------------------
  // User grants (Owner, or the user's own Department Head)
  // ---------------------------------------------------------------------

  async getUserGrants(actor: AppUser, userId: string) {
    const target = await this.assertCanViewUser(actor, userId);
    const explicitModuleIds = await this.getUserExplicitModuleIds(userId);
    const departmentEffectiveModuleIds = [
      ...(target.departmentId
        ? await this.getDepartmentEffectiveModuleIds(target.departmentId)
        : await this.resolveModuleIds([])),
    ];
    const effectiveModuleIds = [
      ...(await this.getEffectiveModuleIdsForAppUser(target)),
    ];
    return {
      userId,
      explicitModuleIds,
      effectiveModuleIds,
      departmentEffectiveModuleIds,
    };
  }

  /**
   * Owner may grant a DEPARTMENT_USER any active module. A
   * DEPARTMENT_HEAD may only grant a DEPARTMENT_USER within their own
   * department, and — the actual hierarchical-enforcement requirement —
   * only modules within the Head's OWN effective set (their
   * department's grants + defaults, ancestors included). Checked here,
   * server-side, on every write — never only hidden in the UI. Full
   * replace.
   */
  async setUserGrants(actor: AppUser, userId: string, moduleIds: number[]) {
    const target = await this.assertManageableUserTarget(actor, userId);
    await this.assertModuleIdsExist(moduleIds);

    if (actor.systemRole !== 'MUNICIPALITY_OWNER') {
      const headSet = await this.getEffectiveModuleIdsForAppUser(actor);
      const disallowed = moduleIds.filter((id) => !headSet.has(id));
      if (disallowed.length > 0) {
        throw new ForbiddenException(
          `You cannot grant modules your own department does not have access to: ${disallowed.join(', ')}.`,
        );
      }
    }

    await this.prisma.$transaction([
      this.prisma.userModuleGrant.deleteMany({ where: { userId } }),
      this.prisma.userModuleGrant.createMany({
        data: moduleIds.map((moduleId) => ({
          userId,
          moduleId,
          grantedById: actor.id,
        })),
      }),
    ]);

    return this.getUserGrants(actor, target.id);
  }

  // ---------------------------------------------------------------------
  // Authorization helpers
  // ---------------------------------------------------------------------

  private async assertDepartmentInMunicipality(
    municipalityId: string,
    departmentId: string,
  ): Promise<void> {
    const exists = await this.prisma.department.findFirst({
      where: { id: departmentId, municipalityId },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('Department not found.');
    }
  }

  private async assertCanViewDepartment(
    actor: AppUser,
    departmentId: string,
  ): Promise<void> {
    if (actor.systemRole === 'DEPARTMENT_USER') {
      throw new ForbiddenException(
        'You do not have permission to view department module access.',
      );
    }
    await this.assertDepartmentInMunicipality(
      actor.municipalityId,
      departmentId,
    );
    if (
      actor.systemRole === 'DEPARTMENT_HEAD' &&
      actor.departmentId !== departmentId
    ) {
      throw new ForbiddenException(
        'You can only view module access for your own department.',
      );
    }
  }

  /** Owner: any user in the municipality. Head: users in their own
   *  department. */
  private async assertCanViewUser(
    actor: AppUser,
    userId: string,
  ): Promise<ResolvableUser> {
    if (actor.systemRole === 'DEPARTMENT_USER') {
      throw new ForbiddenException(
        'You do not have permission to view module access.',
      );
    }
    const target = await this.prisma.user.findFirst({
      where: { id: userId, municipalityId: actor.municipalityId },
      select: { id: true, departmentId: true, systemRole: true },
    });
    if (!target) {
      throw new NotFoundException('User not found.');
    }
    if (
      actor.systemRole === 'DEPARTMENT_HEAD' &&
      target.departmentId !== actor.departmentId
    ) {
      throw new ForbiddenException(
        'You can only view module access for users in your own department.',
      );
    }
    return target;
  }

  /** A DEPARTMENT_USER is the only kind of target this endpoint ever
   *  manages, for Owner and Head alike — a Department Head's own access
   *  IS their department's grant (see getEffectiveModuleIdsForAppUser),
   *  there is no separate per-Head UserModuleGrant row, so writing one
   *  here would just be silently-ignored dead data. Owner: any
   *  DEPARTMENT_USER in the municipality. Head: only a DEPARTMENT_USER
   *  within their own department — never a peer Head, never the Owner. */
  private async assertManageableUserTarget(
    actor: AppUser,
    userId: string,
  ): Promise<ResolvableUser> {
    const target = await this.prisma.user.findFirst({
      where: { id: userId, municipalityId: actor.municipalityId },
      select: { id: true, departmentId: true, systemRole: true },
    });
    if (!target) {
      throw new NotFoundException('User not found.');
    }
    if (target.systemRole !== 'DEPARTMENT_USER') {
      throw new ForbiddenException(
        'Module access can only be assigned to a Department User directly — a Department Head’s access comes from their department’s own grant.',
      );
    }

    if (actor.systemRole === 'MUNICIPALITY_OWNER') {
      return target;
    }

    if (
      actor.systemRole === 'DEPARTMENT_HEAD' &&
      !!actor.departmentId &&
      target.departmentId === actor.departmentId
    ) {
      return target;
    }

    throw new ForbiddenException(
      'You do not have permission to manage module access for this user.',
    );
  }

  private async assertModuleIdsExist(moduleIds: number[]): Promise<void> {
    if (moduleIds.length === 0) {
      return;
    }
    const found = await this.prisma.module.findMany({
      where: { id: { in: moduleIds }, isActive: true },
      select: { id: true },
    });
    if (found.length !== new Set(moduleIds).size) {
      const foundIds = new Set(found.map((m) => m.id));
      const missing = [...new Set(moduleIds.filter((id) => !foundIds.has(id)))];
      throw new BadRequestException(
        `Unknown or inactive module id(s): ${missing.join(', ')}.`,
      );
    }
  }
}
