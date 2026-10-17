import { Component, EventEmitter, Input, Output, ViewChild, inject, signal } from '@angular/core';
import { MenuItem } from 'primeng/api';
import { Menu, MenuModule } from 'primeng/menu';
import { NgTemplateOutlet } from '@angular/common';
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
  imports: [NgTemplateOutlet, FormsModule, ButtonModule, CheckboxModule, MenuModule, SelectModule, TooltipModule],
  templateUrl: './layer-panel.component.html',
  styleUrl: './layer-panel.component.scss'
})
export class LayerPanelComponent {
  private readonly mapService = inject(MapService);

  @Input({ required: true }) layers: GisLayer[] = [];
  /** Task 9 §4: a layer arriving here via a dashboard deep link gets a
   *  brief visual highlight so the user can see what the click landed on. */
  @Input() highlightLayerId: string | null = null;
  /** Basemap picker — needs the Basemap module (17). */
  @Input() showBasemap = true;
  /** Layer Styling module granted — hides the style buttons otherwise. */
  @Input() canStyle = false;
  /** Opens the reusable style editor for this layer (GIS Layer Styling). */
  @Output() styleLayer = new EventEmitter<GisLayer>();
  /** Owner: rename / delete straight from the map's layer list. */
  @Input() canManage = false;
  @Output() renameLayer = new EventEmitter<{ layer: GisLayer; name: string }>();
  @Output() deleteLayer = new EventEmitter<GisLayer>();

  /** Layer whose name is being edited in place, and the draft name. */
  readonly renamingId = signal<string | null>(null);
  renameDraft = '';

  private beginRename(layer: GisLayer): void {
    this.renamingId.set(layer.id);
    this.renameDraft = layer.name;
    setTimeout(() => {
      const input = document.querySelector<HTMLInputElement>('.layer-panel__rename');
      input?.focus();
      input?.select();
    });
  }

  commitRename(layer: GisLayer): void {
    const name = this.renameDraft.trim();
    this.renamingId.set(null);
    if (name.length >= 2 && name !== layer.name) this.renameLayer.emit({ layer, name });
  }

  cancelRename(): void {
    this.renamingId.set(null);
  }

  @ViewChild('moreMenu') private moreMenu?: Menu;
  /** Items of the shared More menu, built for the layer it was opened on. */
  moreItems: MenuItem[] = [];

  get hasMoreActions(): boolean {
    return this.canStyle || this.canManage;
  }

  openMore(layer: GisLayer, event: Event): void {
    event.stopPropagation();
    this.moreItems = [
      ...(this.canStyle
        ? [{ label: 'Style layer', icon: 'pi pi-palette', command: () => this.styleLayer.emit(layer) }]
        : []),
      ...(this.canManage
        ? [
            { label: 'Rename', icon: 'pi pi-pencil', command: () => this.beginRename(layer) },
            { separator: true },
            { label: 'Delete layer', icon: 'pi pi-trash', styleClass: 'layer-panel__menu-danger', command: () => this.deleteLayer.emit(layer) }
          ]
        : [])
    ];
    this.moreMenu?.toggle(event);
  }

  onDelete(layer: GisLayer, event: Event): void {
    event.stopPropagation();
    this.deleteLayer.emit(layer);
  }

  readonly visibility = this.mapService.layerVisibility;

  /** Basemap picker — same shared MapService, surfaced here in the layer
   *  panel rather than floating over the map surface. */
  readonly basemapOptions = this.mapService.basemapOptions;
  readonly activeBasemap = this.mapService.activeBasemap;

  onBasemapChange(id: string): void {
    this.mapService.setBasemap(id);
  }

  onZoom(layer: GisLayer, event: Event): void {
    event.stopPropagation();
    this.mapService.zoomToLayer(layer);
  }

  get canonicalLayers(): GisLayer[] {
    return this.layers.filter((layer) => layer.ownershipType === 'CANONICAL' && !layer.rasterAnalysis);
  }

  /** Raster Analysis uploads, downloads and results, whoever owns them. */
  get rasterAnalysisLayers(): GisLayer[] {
    return this.layers.filter((layer) => layer.rasterAnalysis);
  }

  get departmentGroups(): LayerPanelDepartmentGroup[] {
    const groups = new Map<string, LayerPanelDepartmentGroup>();
    for (const layer of this.layers) {
      if (layer.ownershipType !== 'DEPARTMENT' || layer.rasterAnalysis) continue;
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

  /** Layers whose full legend is expanded under the row. */
  readonly openLegends = signal<ReadonlySet<string>>(new Set());
  /** Layers GeoServer returned no legend image for. */
  readonly legendFailed = new Set<string>();

  isLegendOpen(layerId: string): boolean {
    return this.openLegends().has(layerId);
  }

  toggleLegend(layerId: string): void {
    const next = new Set(this.openLegends());
    next.has(layerId) ? next.delete(layerId) : next.add(layerId);
    this.openLegends.set(next);
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
