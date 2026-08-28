import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule, CheckboxChangeEvent } from 'primeng/checkbox';
import { SelectModule } from 'primeng/select';
import { TooltipModule } from 'primeng/tooltip';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { MapService } from '../../services/map.service';

export interface LayerPanelDepartmentGroup {
  departmentId: string;
  departmentName: string;
  layers: GisLayer[];
}

/**
 * Displays the toggleable layer list (Task 6 §12), grouped into
 * "Canonical Layers" (CANONICAL — the Task 6 demo layers plus anything the
 * Owner publishes without a department) and "Department Layers"
 * (DEPARTMENT — Task 7 uploaded operational layers), per Task 7 §44 and
 * Task 9 §3 — department layers are further sub-grouped by their own
 * department (e.g. separate "Roads", "Water" headings) rather than one
 * flat bucket, so a user can tell at a glance which department owns what.
 * The grouping comes entirely from backend metadata (`layer.ownershipType`
 * / `layer.departmentId`/`departmentName`) — nothing here is hard-coded
 * per layer or department name. Reads/writes visibility entirely through
 * the shared MapService — toggling a checkbox calls `setLayerVisibility`,
 * which only touches that one OpenLayers layer's `visible` flag
 * (`layer.setVisible()`), never reloading the map or re-fetching layer
 * metadata.
 */
@Component({
  selector: 'app-layer-panel',
  standalone: true,
  imports: [FormsModule, ButtonModule, CheckboxModule, SelectModule, TooltipModule],
  templateUrl: './layer-panel.component.html',
  styleUrl: './layer-panel.component.scss'
})
export class LayerPanelComponent {
  private readonly mapService = inject(MapService);

  @Input({ required: true }) layers: GisLayer[] = [];
  /** Task 9 §4: a layer arriving here via a dashboard deep link gets a
   *  brief visual highlight so the user can see what the click landed on. */
  @Input() highlightLayerId: string | null = null;
  /** Opens the reusable style editor for this layer (GIS Layer Styling). */
  @Output() styleLayer = new EventEmitter<GisLayer>();

  readonly visibility = this.mapService.layerVisibility;

  /** Basemap picker — same shared MapService, surfaced here in the layer
   *  panel rather than floating over the map surface. */
  readonly basemapOptions = this.mapService.basemapOptions;
  readonly activeBasemap = this.mapService.activeBasemap;

  onBasemapChange(id: string): void {
    this.mapService.setBasemap(id);
  }

  get canonicalLayers(): GisLayer[] {
    return this.layers.filter((layer) => layer.ownershipType === 'CANONICAL');
  }

  get departmentGroups(): LayerPanelDepartmentGroup[] {
    const groups = new Map<string, LayerPanelDepartmentGroup>();
    for (const layer of this.layers) {
      if (layer.ownershipType !== 'DEPARTMENT') continue;
      const departmentId = layer.departmentId ?? 'unassigned';
      const departmentName = layer.departmentName ?? 'Unassigned';
      const existing = groups.get(departmentId);
      if (existing) {
        existing.layers.push(layer);
      } else {
        groups.set(departmentId, { departmentId, departmentName, layers: [layer] });
      }
    }
    return [...groups.values()].sort((a, b) => a.departmentName.localeCompare(b.departmentName));
  }

  isVisible(layerId: string): boolean {
    return this.visibility()[layerId] ?? false;
  }

  onToggle(layerId: string, event: CheckboxChangeEvent): void {
    this.mapService.setLayerVisibility(layerId, !!event.checked);
  }

  legendUrl(layer: GisLayer): string {
    return this.mapService.legendGraphicUrl(layer);
  }

  onStyle(layer: GisLayer, event: Event): void {
    event.stopPropagation();
    this.styleLayer.emit(layer);
  }
}
