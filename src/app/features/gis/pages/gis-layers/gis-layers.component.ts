import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { InputTextModule } from 'primeng/inputtext';
import { PaginatorModule, PaginatorState } from 'primeng/paginator';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { TooltipModule } from 'primeng/tooltip';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { StyleGeometry } from '../../../../core/models/layer-style.model';
import { StyleEditorComponent } from '../../components/style-editor/style-editor.component';

/**
 * GIS Layer Management screen (Task 8 §6) — extends the GIS area
 * alongside the existing Municipal GIS map (/gis) and GIS Data upload
 * history (/gis/uploads) rather than replacing either. The layer list
 * itself is already permission-filtered server-side (GET /api/gis/layers,
 * Task 8 §8) — a layer this user cannot VIEW never appears here at all.
 *
 * "Manage"/"Export" are shown only for the Owner as a best-effort UI
 * hint (Task 8 §10: "frontend permission checks are only for UI") —
 * the real gate is always the backend's MANAGE/EXPORT check, which also
 * covers the less common case of a Department Head/User who has been
 * explicitly granted one of those beyond the §4 defaults; such a user
 * would need to navigate to the permissions screen directly (its own
 * 403 handling covers that gap honestly rather than guessing every
 * possible grant combination client-side).
 */
@Component({
  selector: 'app-gis-layers',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    TableModule,
    DialogModule,
    InputTextModule,
    PaginatorModule,
    TagModule,
    MessageModule,
    TooltipModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent,
    StyleEditorComponent
  ],
  templateUrl: './gis-layers.component.html',
  styleUrl: './gis-layers.component.scss'
})
export class GisLayersComponent {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly router = inject(Router);
  private readonly notify = inject(NotificationService);

  readonly currentUser = signal<CurrentUser | null>(null);
  readonly layers = signal<GisLayer[]>([]);
  readonly loading = signal(true);
  readonly pageError = signal<string | null>(null);

  readonly detailLayer = signal<GisLayer | null>(null);
  readonly exporting = signal<string | null>(null);
  readonly deleting = signal<string | null>(null);
  readonly styleLayer = signal<GisLayer | null>(null);

  /** Client-side search over the already-fetched (permission-filtered)
   *  list — the backend has no search param for layers and the list is
   *  already fetched in full. */
  readonly searchTerm = signal('');
  readonly filteredLayers = computed(() => {
    const term = this.searchTerm().trim().toLowerCase();
    const all = this.layers();
    if (!term) {
      return all;
    }
    return all.filter(
      (l) => l.name.toLowerCase().includes(term) || (l.departmentName ?? '').toLowerCase().includes(term)
    );
  });

  /** Pagination is purely client-side over filteredLayers — same pattern
   *  as Departments/Users. */
  readonly first = signal(0);
  readonly pageSize = signal(10);
  readonly pageSizes = [10, 25, 50];
  readonly pagedLayers = computed(() =>
    this.filteredLayers().slice(this.first(), this.first() + this.pageSize())
  );

  /** At-a-glance summary tiles above the table. */
  readonly totalLayers = computed(() => this.layers().length);
  readonly departmentLayerCount = computed(
    () => this.layers().filter((l) => l.ownershipType === 'DEPARTMENT').length
  );
  readonly canonicalLayerCount = computed(
    () => this.layers().filter((l) => l.ownershipType === 'CANONICAL').length
  );

  constructor() {
    this.currentUserService.getMe().subscribe({ next: (user) => this.currentUser.set(user) });
    this.loadLayers();
  }

  get isOwner(): boolean {
    return this.currentUser()?.systemRole === 'MUNICIPALITY_OWNER';
  }

  loadLayers(): void {
    this.loading.set(true);
    this.pageError.set(null);
    this.gisLayersService.list().subscribe({
      next: (layers) => {
        this.layers.set(layers);
        this.clampFirst(this.filteredLayers().length);
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load GIS layers. Please try again.');
        this.loading.set(false);
      }
    });
  }

  onSearchChange(value: string): void {
    this.searchTerm.set(value);
    this.first.set(0);
  }

  onPageChange(event: PaginatorState): void {
    this.first.set(event.first ?? 0);
    if (event.rows) {
      this.pageSize.set(event.rows);
    }
  }

  /** Keeps the current page in range after the underlying list shrinks
   *  (e.g. deleting the last layer on the last page) — never leaves the
   *  paginator pointing at a page that no longer exists. */
  private clampFirst(total: number): void {
    if (total === 0) {
      this.first.set(0);
      return;
    }
    const lastPageFirst = Math.floor((total - 1) / this.pageSize()) * this.pageSize();
    if (this.first() > lastPageFirst) {
      this.first.set(lastPageFirst);
    }
  }

  viewDetail(layer: GisLayer): void {
    this.detailLayer.set(layer);
  }

  closeDetail(): void {
    this.detailLayer.set(null);
  }

  openPermissions(layer: GisLayer): void {
    this.router.navigate(['/gis/layers', layer.id, 'permissions']);
  }

  openStyle(layer: GisLayer): void {
    this.styleLayer.set(layer);
  }

  styleGeometryOf(layer: GisLayer): StyleGeometry {
    if (layer.layerType === 'RASTER') return 'raster';
    if (layer.geometryType === 'POINT') return 'point';
    if (layer.geometryType === 'LINE') return 'line';
    return 'polygon';
  }

  onStyleSaved(): void {
    this.styleLayer.set(null);
    this.loadLayers();
  }

  /** Hard delete — unpublishes the layer from GeoServer and permanently
   *  drops its data. Owner-only; the real gate is the backend. The list
   *  is a permission-filtered snapshot, so on success we just drop the
   *  row locally rather than refetching. */
  deleteLayer(layer: GisLayer): void {
    this.notify.confirmDelete({
      message: `Delete "${layer.name}"? This unpublishes the layer and permanently removes its data and upload history. This cannot be undone.`,
      accept: () => {
        this.deleting.set(layer.id);
        this.gisLayersService.delete(layer.id).subscribe({
          next: () => {
            this.deleting.set(null);
            this.notify.success(`"${layer.name}" was deleted.`);
            this.layers.update((layers) => layers.filter((l) => l.id !== layer.id));
            this.clampFirst(this.filteredLayers().length);
            if (this.detailLayer()?.id === layer.id) {
              this.closeDetail();
            }
          },
          error: (error: HttpErrorResponse) => {
            this.deleting.set(null);
            this.notify.error(error.error?.message ?? 'Delete failed. Please try again.');
          }
        });
      }
    });
  }

  /** Triggers a real browser download of the GeoJSON returned by the
   *  (permission-gated) backend export endpoint — a standard Blob +
   *  object-URL download, not related to any artifact/sandbox
   *  restriction (this is the deployed application running in the
   *  user's own browser). */
  export(layer: GisLayer): void {
    this.exporting.set(layer.id);
    this.gisLayersService.export(layer.id).subscribe({
      next: (content) => {
        this.exporting.set(null);
        const blob = new Blob([content], { type: 'application/geo+json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${layer.code.toLowerCase()}.geojson`;
        anchor.click();
        URL.revokeObjectURL(url);
        this.notify.success(`Exported "${layer.name}" as GeoJSON.`);
      },
      error: (error: HttpErrorResponse) => {
        this.exporting.set(null);
        this.notify.error(error.error?.message ?? 'Export failed. Please try again.');
      }
    });
  }
}
