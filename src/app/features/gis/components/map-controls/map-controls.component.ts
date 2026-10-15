import { Component, Input, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { Popover, PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MapService } from '../../services/map.service';
import { GOTO_COORDINATE_SYSTEMS } from '../../services/projections';

/** Module Access catalog ids (seed-modules.ts) for the gated controls. */
const NAV_HISTORY_MODULE_ID = 59;
const GOTO_XY_MODULE_ID = 12;

/** In-map navigation controls — zoom in/out, reset to the initial extent,
 *  fullscreen, Nav History (back/forward through previous views) and
 *  Go To X:Y. The basemap picker lives in the map card toolbar (outside
 *  the map surface), not here. */
@Component({
  selector: 'app-map-controls',
  standalone: true,
  imports: [FormsModule, ButtonModule, TooltipModule, PopoverModule, SelectModule, InputTextModule],
  templateUrl: './map-controls.component.html',
  styleUrl: './map-controls.component.scss'
})
export class MapControlsComponent {
  private readonly mapService = inject(MapService);

  /** Module Access ids granted to the current user; gates Nav History and
   *  Go To X:Y the same way the workspace gates its tools. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());

  readonly showNavHistory = computed(() => this.allowed().has(NAV_HISTORY_MODULE_ID));
  readonly showGoTo = computed(() => this.allowed().has(GOTO_XY_MODULE_ID));
  readonly canGoBack = this.mapService.canGoBack;
  readonly canGoForward = this.mapService.canGoForward;

  @ViewChild('gotoPopover') private gotoPopover?: Popover;

  readonly coordinateSystems = GOTO_COORDINATE_SYSTEMS;
  readonly crs = signal(GOTO_COORDINATE_SYSTEMS[0].code);
  readonly xInput = signal('');
  readonly yInput = signal('');
  readonly gotoError = signal<string | null>(null);
  readonly gotoResult = signal<string | null>(null);

  readonly crsOption = computed(
    () => GOTO_COORDINATE_SYSTEMS.find((c) => c.code === this.crs()) ?? GOTO_COORDINATE_SYSTEMS[0]
  );

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

  goBack(): void {
    this.mapService.goBack();
  }

  goForward(): void {
    this.mapService.goForward();
  }

  toggleGoTo(event: Event): void {
    this.gotoPopover?.toggle(event);
  }

  /** Accepts "73.12" or "73,12" style decimals; for geographic input also
   *  the common "lat, lon" paste into the X field (two numbers at once). */
  goTo(): void {
    this.gotoError.set(null);
    this.gotoResult.set(null);
    const option = this.crsOption();
    let x = parseCoordinate(this.xInput());
    let y = parseCoordinate(this.yInput());

    const pair = this.xInput().trim().split(/[\s,;]+/).filter(Boolean);
    if (Number.isNaN(y) && pair.length === 2) {
      // "20.89, 70.40" pasted into one box: geographic pastes are usually
      // lat, lon — swap into X = lon, Y = lat.
      const [a, b] = pair.map(Number);
      [x, y] = option.geographic ? [b, a] : [a, b];
      this.xInput.set(String(x));
      this.yInput.set(String(y));
    }

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      this.gotoError.set(`Enter both ${option.axes[0]} and ${option.axes[1]} as numbers.`);
      return;
    }
    if (option.geographic && (Math.abs(x) > 180 || Math.abs(y) > 90)) {
      this.gotoError.set('Longitude must be within ±180 and latitude within ±90.');
      return;
    }
    const lonLat = this.mapService.goToCoordinate(x, y, option.code);
    if (!lonLat) {
      this.gotoError.set('That coordinate is outside the selected coordinate system.');
      return;
    }
    this.gotoResult.set(`Lon ${lonLat[0].toFixed(6)}, Lat ${lonLat[1].toFixed(6)}`);
  }

  clearGoTo(): void {
    this.mapService.clearGoToMarker();
    this.gotoResult.set(null);
    this.gotoError.set(null);
  }
}

function parseCoordinate(value: string): number {
  const trimmed = value.trim();
  if (!trimmed || /[\s;]/.test(trimmed) || trimmed.split(',').length > 2) return Number.NaN;
  return Number(trimmed.replace(',', '.'));
}
