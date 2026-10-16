import { Component, computed, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators, FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { NgTemplateOutlet } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule, CheckboxChangeEvent } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { DialogModule } from 'primeng/dialog';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { CurrentUserService } from '../../core/services/current-user.service';
import { DepartmentService } from '../../core/services/department.service';
import { UserManagementService } from '../../core/services/user-management.service';
import { ModuleAccessService } from '../../core/services/module-access.service';
import { NotificationService } from '../../core/services/notification.service';
import { CurrentUser } from '../../core/models/current-user.model';
import { Department } from '../../core/models/department.model';
import { MunicipalityUser } from '../../core/models/municipality-user.model';
import {
  DEVELOPED_MODULE_IDS,
  ModuleCatalogEntry,
  ModuleDevStatus,
  ModuleType,
  MODULE_TYPES
} from '../../core/models/module-access.model';

/** `catalog` is the Owner's view of the module list itself (browse/delete). */
type TargetKind = 'department' | 'user' | 'catalog';

const TYPE_LABELS: Record<ModuleType, string> = {
  mainleft: 'Main — Left Rail',
  mainright: 'Main — Right Rail',
  bottomvertical: 'Bottom — Vertical',
  bottomhorizontal: 'Bottom — Horizontal',
  other: 'Other'
};

/** One catalog row, flattened for display: how deep it sits in the
 *  hierarchy (for indentation) and whether it's currently checked. */
interface ModuleRow {
  module: ModuleCatalogEntry;
  depth: number;
  /** Explicitly granted — what the checkbox itself reflects and what a
   *  toggle adds/removes from the saved set. */
  explicit: boolean;
  /** In the resolved effective set but not explicit — a default module,
   *  or an ancestor of something explicit. Shown checked + disabled. */
  implied: boolean;
  /** For a User target only: outside the department's own effective
   *  set, so a Head could never grant it — shown disabled with a note,
   *  never sent even if somehow already explicit (stale after a
   *  department grant was later revoked). */
  outOfReach: boolean;
}

/** Catalog in display order: depth-first along the hierarchy, siblings
 *  by displayPriority (unset last), then name — so the list reads in the
 *  same order the tools appear in the app. Modules whose parent is
 *  missing are listed at the end rather than dropped. */
function orderCatalog(modules: ModuleCatalogEntry[]): ModuleCatalogEntry[] {
  const ids = new Set(modules.map((m) => m.id));
  const childrenOf = new Map<number | null, ModuleCatalogEntry[]>();
  for (const m of modules) {
    const parent = m.parentId !== null && ids.has(m.parentId) ? m.parentId : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), m]);
  }
  const bySiblingOrder = (a: ModuleCatalogEntry, b: ModuleCatalogEntry) =>
    (a.displayPriority ?? Number.MAX_SAFE_INTEGER) - (b.displayPriority ?? Number.MAX_SAFE_INTEGER) ||
    a.name.localeCompare(b.name);
  const ordered: ModuleCatalogEntry[] = [];
  const seen = new Set<number>();
  const walk = (parent: number | null) => {
    for (const m of [...(childrenOf.get(parent) ?? [])].sort(bySiblingOrder)) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      ordered.push(m);
      walk(m.id);
    }
  };
  walk(null);
  return ordered;
}

/**
 * Module Access admin screen: the Municipality Owner assigns a subset of
 * the module catalog to a Department (which becomes that Department's
 * Head's own access); a Department Head assigns a further subset of
 * their own department's access to their Department Users. Every rule
 * here is a UI convenience — the backend (ModuleAccessService) enforces
 * the same hierarchy independently and is the real gate; see its class
 * doc. Owner sees both "Departments" and "Users" as assignable target
 * kinds; a Head sees only "Users", scoped to their own department by
 * the existing tenant-scoped user list.
 */
@Component({
  selector: 'app-module-access',
  standalone: true,
  imports: [
    NgTemplateOutlet,
    FormsModule,
    ReactiveFormsModule,
    ButtonModule,
    CheckboxModule,
    SelectModule,
    InputTextModule,
    InputNumberModule,
    DialogModule,
    MessageModule,
    TagModule,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './module-access.component.html',
  styleUrl: './module-access.component.scss'
})
export class ModuleAccessComponent {
  private readonly currentUserService = inject(CurrentUserService);
  private readonly departmentService = inject(DepartmentService);
  private readonly userService = inject(UserManagementService);
  private readonly moduleAccessService = inject(ModuleAccessService);
  private readonly notify = inject(NotificationService);
  private readonly fb = inject(FormBuilder);

  readonly currentUser = signal<CurrentUser | null>(null);
  readonly isOwner = computed(() => this.currentUser()?.systemRole === 'MUNICIPALITY_OWNER');

  readonly catalog = signal<ModuleCatalogEntry[]>([]);
  readonly catalogLoading = signal(true);
  readonly departments = signal<Department[]>([]);
  readonly users = signal<MunicipalityUser[]>([]);

  readonly targetKind = signal<TargetKind>('department');
  readonly selectedDepartmentId = signal<string | null>(null);
  readonly selectedUserId = signal<string | null>(null);

  /** The saved explicit ids for whatever is currently selected — the
   *  ground truth the tree renders from and toggles mutate a working
   *  copy of. */
  readonly explicitIds = signal<Set<number>>(new Set());
  /** For a User target: their department's effective set — the ceiling
   *  a Head may grant from (see ModuleRow.outOfReach). Null while a
   *  Department is selected (no ceiling applies there). */
  readonly ceilingIds = signal<Set<number> | null>(null);

  readonly grantsLoading = signal(false);
  readonly savingModuleId = signal<number | null>(null);
  readonly pageError = signal<string | null>(null);
  readonly forbidden = signal(false);

  /** Client-side filter over the catalog tree — matches the plain
   *  substring-over-a-fetched-list pattern used by Departments/Users
   *  rather than adding a backend search param for what is at most a
   *  few hundred rows. */
  readonly moduleSearchTerm = signal('');

  readonly typeOptions = MODULE_TYPES.map((type) => ({ label: TYPE_LABELS[type], value: type }));

  readonly deletingModuleId = signal<number | null>(null);

  /** Sub-module count per module id, for the delete confirmation. */
  readonly descendantCounts = computed(() => {
    const childrenOf = new Map<number, number[]>();
    for (const m of this.catalog()) {
      if (m.parentId === null) continue;
      childrenOf.set(m.parentId, [...(childrenOf.get(m.parentId) ?? []), m.id]);
    }
    const count = (id: number, seen: Set<number>): number => {
      let total = 0;
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        total += 1 + count(child, seen);
      }
      return total;
    };
    return new Map(this.catalog().map((m) => [m.id, count(m.id, new Set([m.id]))]));
  });

  /** Development status per module id. A module not built itself is
   *  "partial" when some sub-module under it is built. */
  readonly devStatus = computed(() => {
    const childrenOf = new Map<number, number[]>();
    for (const m of this.catalog()) {
      if (m.parentId === null) continue;
      childrenOf.set(m.parentId, [...(childrenOf.get(m.parentId) ?? []), m.id]);
    }
    const hasDevelopedDescendant = (id: number, seen: Set<number>): boolean =>
      (childrenOf.get(id) ?? []).some((child) => {
        if (seen.has(child)) return false;
        seen.add(child);
        return DEVELOPED_MODULE_IDS.has(child) || hasDevelopedDescendant(child, seen);
      });
    return new Map<number, ModuleDevStatus>(
      this.catalog().map((m) => [
        m.id,
        DEVELOPED_MODULE_IDS.has(m.id)
          ? 'developed'
          : hasDevelopedDescendant(m.id, new Set([m.id]))
            ? 'partial'
            : 'not-developed'
      ])
    );
  });

  readonly developedCount = computed(
    () => [...this.devStatus().values()].filter((s) => s === 'developed').length
  );

  readonly addModuleDialogVisible = signal(false);
  readonly addModuleSubmitting = signal(false);
  readonly addModuleError = signal<string | null>(null);
  readonly addModuleForm = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    parentId: this.fb.control<number | null>(null),
    type: this.fb.control<ModuleType | null>(null),
    defaultModule: [false],
    displayPriority: this.fb.control<number | null>(null)
  });

  constructor() {
    this.currentUserService.getMe().subscribe({
      next: (user) => {
        this.currentUser.set(user);
        if (user.systemRole !== 'MUNICIPALITY_OWNER') {
          this.targetKind.set('user');
        }
      }
    });
    this.loadCatalog();
    this.departmentService.list().subscribe({
      next: (departments) => this.departments.set(departments.filter((d) => d.status === 'ACTIVE'))
    });
    this.userService.list({ status: 'ACTIVE' }).subscribe({
      next: (users) => this.users.set(users.filter((u) => u.systemRole === 'DEPARTMENT_USER'))
    });
  }

  private loadCatalog(): void {
    this.catalogLoading.set(true);
    this.moduleAccessService.getCatalog().subscribe({
      next: (catalog) => {
        this.catalog.set(catalog);
        this.catalogLoading.set(false);
      },
      error: () => this.catalogLoading.set(false)
    });
  }

  get departmentOptions(): { label: string; value: string }[] {
    return this.departments().map((d) => ({ label: d.name, value: d.id }));
  }

  get userOptions(): { label: string; value: string }[] {
    return this.users().map((u) => ({
      label: u.department ? `${u.fullName} (${u.department.name})` : u.fullName,
      value: u.id
    }));
  }

  selectTargetKind(kind: TargetKind): void {
    this.targetKind.set(kind);
    this.selectedDepartmentId.set(null);
    this.selectedUserId.set(null);
    this.explicitIds.set(new Set());
    this.ceilingIds.set(null);
    this.pageError.set(null);
    this.forbidden.set(false);
  }

  selectDepartment(departmentId: string | null): void {
    this.selectedDepartmentId.set(departmentId);
    if (!departmentId) return;
    this.grantsLoading.set(true);
    this.pageError.set(null);
    this.forbidden.set(false);
    this.moduleAccessService.getDepartmentGrants(departmentId).subscribe({
      next: (grants) => {
        this.explicitIds.set(new Set(grants.explicitModuleIds));
        this.ceilingIds.set(null);
        this.grantsLoading.set(false);
      },
      error: (error: HttpErrorResponse) => this.onLoadError(error)
    });
  }

  selectUser(userId: string | null): void {
    this.selectedUserId.set(userId);
    if (!userId) return;
    this.grantsLoading.set(true);
    this.pageError.set(null);
    this.forbidden.set(false);
    this.moduleAccessService.getUserGrants(userId).subscribe({
      next: (grants) => {
        this.explicitIds.set(new Set(grants.explicitModuleIds));
        this.ceilingIds.set(new Set(grants.departmentEffectiveModuleIds));
        this.grantsLoading.set(false);
      },
      error: (error: HttpErrorResponse) => this.onLoadError(error)
    });
  }

  private onLoadError(error: HttpErrorResponse): void {
    this.grantsLoading.set(false);
    if (error.status === 403) {
      this.forbidden.set(true);
      return;
    }
    this.pageError.set('Could not load module access. Please try again.');
  }

  /** The flattened, depth-ordered, checkbox-ready module list — the
   *  core hierarchy resolution the template renders. */
  readonly rows = computed<ModuleRow[]>(() => {
    const catalog = orderCatalog(this.catalog());
    const explicit = this.explicitIds();
    const ceiling = this.ceilingIds();
    const effective = this.expandWithAncestors(explicit);

    return catalog.map((module) => {
      const depth = module.nodePath ? module.nodePath.split('.').length - 1 : 0;
      const isExplicit = explicit.has(module.id);
      return {
        module,
        depth,
        explicit: isExplicit,
        implied: !isExplicit && (!!module.defaultModule || effective.has(module.id)),
        outOfReach: !!ceiling && !ceiling.has(module.id) && !module.defaultModule
      };
    });
  });

  /** `rows()` filtered by the module search box — a plain substring
   *  match against the name, same trade-off as `rows` itself: simple and
   *  fast enough for a catalog this size, at the cost of not re-nesting
   *  a match's ancestors back in when they themselves don't match. */
  readonly filteredRows = computed<ModuleRow[]>(() => {
    const term = this.moduleSearchTerm().trim().toLowerCase();
    const rows = this.rows();
    if (!term) return rows;
    return rows.filter((row) => row.module.name.toLowerCase().includes(term));
  });

  /** At-a-glance counts for the currently selected target — explicit
   *  grants are what the checkboxes reflect; effective is that set
   *  expanded with defaults/ancestors, i.e. what the target actually has
   *  access to. */
  readonly explicitCount = computed(() => this.explicitIds().size);
  readonly effectiveCount = computed(() => this.rows().filter((r) => r.explicit || r.implied).length);
  readonly catalogTotal = computed(() => this.catalog().length);

  onModuleSearchChange(value: string): void {
    this.moduleSearchTerm.set(value);
  }

  /** Flattened, indented catalog options for the "Add Module" dialog's
   *  parent picker — same depth-first nodePath ordering as the tree
   *  itself, so a parent's position in the list matches where the new
   *  module will actually land. */
  readonly parentModuleOptions = computed(() =>
    orderCatalog(this.catalog()).map((module) => {
        const depth = module.nodePath ? module.nodePath.split('.').length - 1 : 0;
        return { label: `${'—'.repeat(depth)}${depth ? ' ' : ''}${module.name}`, value: module.id };
      })
  );

  /** Owner-only: deletes a module (and its sub-modules) from the global
   *  catalog after a confirmation that spells out the blast radius. */
  confirmDeleteModule(module: ModuleCatalogEntry): void {
    const children = this.descendantCounts().get(module.id) ?? 0;
    const branch = children ? ` and its ${children} sub-module${children === 1 ? '' : 's'}` : '';
    this.notify.confirmDelete({
      header: 'Delete module',
      message:
        `Delete "${module.name}"${branch} from the module catalog? This removes it for every municipality ` +
        'and revokes any department or user access granted to it. This cannot be undone.',
      accept: () => this.deleteModule(module)
    });
  }

  private deleteModule(module: ModuleCatalogEntry): void {
    this.deletingModuleId.set(module.id);
    this.moduleAccessService.deleteModule(module.id).subscribe({
      next: ({ deletedIds }) => {
        this.deletingModuleId.set(null);
        const removed = new Set(deletedIds);
        this.catalog.update((catalog) => catalog.filter((m) => !removed.has(m.id)));
        this.explicitIds.update((ids) => new Set([...ids].filter((id) => !removed.has(id))));
        this.notify.success(
          deletedIds.length > 1
            ? `"${module.name}" and ${deletedIds.length - 1} sub-module${deletedIds.length === 2 ? '' : 's'} were deleted.`
            : `"${module.name}" was deleted.`
        );
      },
      error: (err: HttpErrorResponse) => {
        this.deletingModuleId.set(null);
        this.notify.error(
          (err.error as { message?: string } | null)?.message ?? 'Could not delete the module. Please try again.'
        );
      }
    });
  }

  openAddModuleDialog(): void {
    this.addModuleError.set(null);
    this.addModuleForm.reset({
      name: '',
      parentId: null,
      type: null,
      defaultModule: false,
      displayPriority: null
    });
    this.addModuleDialogVisible.set(true);
  }

  closeAddModuleDialog(): void {
    this.addModuleDialogVisible.set(false);
  }

  submitAddModule(): void {
    if (this.addModuleForm.invalid) {
      this.addModuleForm.markAllAsTouched();
      return;
    }

    const value = this.addModuleForm.getRawValue();
    this.addModuleSubmitting.set(true);
    this.addModuleError.set(null);

    this.moduleAccessService
      .createModule({
        name: value.name,
        parentId: value.parentId ?? undefined,
        type: value.type ?? undefined,
        defaultModule: value.defaultModule,
        displayPriority: value.displayPriority ?? undefined
      })
      .subscribe({
        next: (module) => {
          this.addModuleSubmitting.set(false);
          this.addModuleDialogVisible.set(false);
          this.loadCatalog();
          this.notify.success(`"${module.name}" was added to the module catalog.`);
        },
        error: (error: HttpErrorResponse) => {
          this.addModuleSubmitting.set(false);
          this.addModuleError.set(error.error?.message ?? 'Could not add the module. Please try again.');
        }
      });
  }

  get amf() {
    return this.addModuleForm.controls;
  }

  /** Client-side mirror of the backend's ancestor-walk (see
   *  ModuleAccessService.resolveModuleIds) — for the "implied" checkbox
   *  preview only; the backend is what actually decides access. */
  private expandWithAncestors(ids: Set<number>): Set<number> {
    const byId = new Map(this.catalog().map((m) => [m.id, m]));
    const result = new Set<number>();
    for (const id of ids) {
      result.add(id);
      const path = byId.get(id)?.nodePath;
      if (path) {
        for (const segment of path.split('.')) {
          const ancestorId = Number(segment);
          if (Number.isInteger(ancestorId)) result.add(ancestorId);
        }
      }
    }
    return result;
  }

  toggle(row: ModuleRow, event: CheckboxChangeEvent): void {
    const next = new Set(this.explicitIds());
    if (event.checked) {
      next.add(row.module.id);
    } else {
      next.delete(row.module.id);
    }
    // A stale grant that's since fallen outside the department's ceiling
    // (e.g. the Owner later revoked it) renders checked-but-disabled —
    // there's no checkbox to uncheck it with. Drop it here rather than
    // resending it: the backend would reject the whole save (it revalidates
    // every id, not just the one just toggled) if we kept sending it.
    const ceiling = this.ceilingIds();
    const filtered = ceiling ? new Set([...next].filter((id) => ceiling.has(id))) : next;
    this.save(filtered);
  }

  private save(next: Set<number>): void {
    const moduleIds = [...next];
    this.savingModuleId.set(-1);
    this.pageError.set(null);

    const onResult = (grants: { explicitModuleIds: number[] }) => {
      this.explicitIds.set(new Set(grants.explicitModuleIds));
      this.savingModuleId.set(null);
    };
    const onError = (error: HttpErrorResponse) => {
      this.savingModuleId.set(null);
      this.pageError.set(error.error?.message ?? 'Could not save module access. Please try again.');
    };

    if (this.targetKind() === 'department') {
      this.moduleAccessService
        .setDepartmentGrants(this.selectedDepartmentId()!, moduleIds)
        .subscribe({ next: onResult, error: onError });
      return;
    }
    this.moduleAccessService
      .setUserGrants(this.selectedUserId()!, moduleIds)
      .subscribe({ next: onResult, error: onError });
  }

  get saving(): boolean {
    return this.savingModuleId() !== null;
  }
}
