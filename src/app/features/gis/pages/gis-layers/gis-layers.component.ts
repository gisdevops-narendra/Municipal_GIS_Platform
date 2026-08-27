import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { TableModule } from 'primeng/table';
import { DialogModule } from 'primeng/dialog';
import { TagModule } from 'primeng/tag';
import { MessageModule } from 'primeng/message';
import { PrimeTemplate } from 'primeng/api';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { CurrentUserService } from '../../../../core/services/current-user.service';
import { CurrentUser } from '../../../../core/models/current-user.model';
import { GisLayer } from '../../../../core/models/gis-layer.model';

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
    ButtonModule,
    TableModule,
    DialogModule,
    TagModule,
    MessageModule,
    PrimeTemplate,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './gis-layers.component.html',
  styleUrl: './gis-layers.component.scss'
})
export class GisLayersComponent {
  private readonly gisLayersService = inject(GisLayersService);
  private readonly currentUserService = inject(CurrentUserService);
  private readonly router = inject(Router);

  readonly currentUser = signal<CurrentUser | null>(null);
  readonly layers = signal<GisLayer[]>([]);
  readonly loading = signal(true);
  readonly pageError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);

  readonly detailLayer = signal<GisLayer | null>(null);
  readonly exporting = signal<string | null>(null);

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
        this.loading.set(false);
      },
      error: () => {
        this.pageError.set('Could not load GIS layers. Please try again.');
        this.loading.set(false);
      }
    });
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

  /** Triggers a real browser download of the GeoJSON returned by the
   *  (permission-gated) backend export endpoint — a standard Blob +
   *  object-URL download, not related to any artifact/sandbox
   *  restriction (this is the deployed application running in the
   *  user's own browser). */
  export(layer: GisLayer): void {
    this.actionError.set(null);
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
      },
      error: (error: HttpErrorResponse) => {
        this.exporting.set(null);
        this.actionError.set(error.error?.message ?? 'Export failed. Please try again.');
      }
    });
  }
}
