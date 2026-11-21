import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { AuthService } from '../../core/services/auth.service';

interface CapabilityItem {
  label: string;
  description: string;
}

@Component({
  selector: 'app-landing',
  standalone: true,
  imports: [RouterLink, ButtonModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './landing.component.html',
  styleUrl: './landing.component.scss'
})
export class LandingComponent {
  readonly isAuthenticated = inject(AuthService).isAuthenticated;

  readonly capabilities: CapabilityItem[] = [
    { label: 'Upload & publish', description: 'Shapefile ZIP, GeoJSON or CSV — validated, reprojected and on the map automatically.' },
    { label: 'Style & label', description: 'Colour by category or value, labels, icons and heatmaps, previewed live on the map.' },
    { label: 'Query & attributes', description: 'Filter features, browse and edit the attribute table, and export the results.' },
    { label: 'Measure & analyse', description: 'Distances, areas, buffers, overlays, statistics and raster analysis.' },
    { label: 'Edit & collect', description: 'Draw and edit features on the map, or collect them in the field, even offline.' },
    { label: 'Print & share', description: 'Print maps with scale, legend and grid, or share a read-only link.' }
  ];
}
