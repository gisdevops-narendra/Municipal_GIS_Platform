import { Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { MapService } from '../../services/map.service';

/** In-map navigation controls only (Task 6 §18) — zoom in/out, reset to the
 *  initial extent, and fullscreen. The basemap picker lives in the map
 *  card toolbar (outside the map surface), not here. No
 *  drawing/editing/measurement tools. */
@Component({
  selector: 'app-map-controls',
  standalone: true,
  imports: [ButtonModule, TooltipModule],
  templateUrl: './map-controls.component.html',
  styleUrl: './map-controls.component.scss'
})
export class MapControlsComponent {
  private readonly mapService = inject(MapService);

  zoomIn(): void {
    this.mapService.zoomIn();
  }

  zoomOut(): void {
    this.mapService.zoomOut();
  }

  resetView(): void {
    this.mapService.resetView();
  }

  toggleFullscreen(): void {
    this.mapService.toggleFullscreen();
  }
}
