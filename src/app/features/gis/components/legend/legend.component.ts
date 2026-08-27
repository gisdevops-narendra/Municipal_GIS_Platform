import { Component, Input, inject } from '@angular/core';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';

/** Floating legend listing only the currently-visible layers (Task 6 §19) —
 *  via GeoServer's WMS GetLegendGraphic, not a custom style editor. */
@Component({
  selector: 'app-legend',
  standalone: true,
  imports: [],
  templateUrl: './legend.component.html',
  styleUrl: './legend.component.scss'
})
export class LegendComponent {
  private readonly mapService = inject(MapService);

  @Input({ required: true }) layers: GisLayer[] = [];
  /** `true` renders the legend as flat panel content (GIS workspace dock);
   *  `false` (default) is the floating on-map card. */
  @Input() inline = false;

  private readonly visibility = this.mapService.layerVisibility;

  get visibleLayers(): GisLayer[] {
    const visibility = this.visibility();
    return this.layers.filter((layer) => visibility[layer.id]);
  }

  legendUrl(layer: GisLayer): string {
    return this.mapService.legendGraphicUrl(layer);
  }
}
