import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';

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
  readonly capabilities: CapabilityItem[] = [
    { label: 'Municipal GIS', description: 'One authoritative map per municipality — parcels, wards, roads and utilities in a single workspace.' },
    { label: 'GIS Data Management', description: 'Upload, validate and publish shapefiles, GeoJSON, CSV and raster data with CRS checks built in.' },
    { label: 'Municipal Assets', description: 'Track streetlights, pipelines, drains and more against a common asset model.' },
    { label: 'Property & Parcels', description: 'Connect parcels to tax, water, sewer and building records at the source.' },
    { label: 'Projects', description: 'Give capital works a geography, a budget and a timeline in the same place.' },
    { label: 'Field Operations', description: 'Assignments, inspections and evidence captured from the field, synced back to the map.' }
  ];
}
