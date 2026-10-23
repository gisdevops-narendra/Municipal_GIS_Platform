import { Component, EventEmitter, Input, Output, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { TooltipModule } from 'primeng/tooltip';
import { Popover, PopoverModule } from 'primeng/popover';
import { SelectModule } from 'primeng/select';
import { InputTextModule } from 'primeng/inputtext';
import { MapService } from '../../services/map.service';
import { CoordinateSystemOption, GOTO_COORDINATE_SYSTEMS } from '../../services/projections';
import { CrsInfo, CrsService } from '../../services/crs.service';
import { CrsPickerComponent } from '../crs-picker/crs-picker.component';
import { NotificationService } from '../../../../core/services/notification.service';
import type { SelectMode, SelectShape } from '../attribute-table/attribute-table.component';

/** Module Access catalog ids (seed-modules.ts) for the gated controls. */
const NAV_HISTORY_MODULE_ID = 59;
const GOTO_XY_MODULE_ID = 12;
const OTHER_CRS = 'other';
const THREE_D_VIEW_MODULE_ID = 74;
const SELECTION_TOOL_MODULE_ID = 57;
const ZOOM_IN_MODULE_ID = 19;
const ZOOM_OUT_MODULE_ID = 20;
const RESET_VIEW_MODULE_ID = 961;
const FULLSCREEN_MODULE_ID = 962;
const INFORMATION_TOOL_MODULE_ID = 58;

/** In-map navigation controls — zoom in/out, reset to the initial extent,
 *  fullscreen, Nav History (back/forward through previous views) and
 *  Go To X:Y, plus the Selection Tool (select features by rectangle,
 *  polygon or lasso — the result lands in the Attribute Table). The basemap picker lives in the map card toolbar (outside
 *  the map surface), not here. */
@Component({
  selector: 'app-map-controls',
  standalone: true,
  imports: [FormsModule, ButtonModule, TooltipModule, PopoverModule, SelectModule, InputTextModule, CrsPickerComponent],
  templateUrl: './map-controls.component.html',
  styleUrl: './map-controls.component.scss'
})
export class MapControlsComponent {
  protected readonly mapService = inject(MapService);
  private readonly notify = inject(NotificationService);

  constructor() {
    this.mapService.notifyGlobeError = (message) => this.notify.error(message, '3D view');
  }

  /** Module Access ids granted to the current user; gates Nav History and
   *  Go To X:Y the same way the workspace gates its tools. */
  @Input() set allowedModuleIds(value: ReadonlySet<number>) {
    this.allowed.set(value ?? new Set());
  }
  private readonly allowed = signal<ReadonlySet<number>>(new Set());

  // 2D-only tools step aside while the map shows the 3D globe.
  readonly showNavHistory = computed(() => this.allowed().has(NAV_HISTORY_MODULE_ID) && !this.mapService.is3d());
  readonly showGoTo = computed(() => this.allowed().has(GOTO_XY_MODULE_ID) && !this.mapService.is3d());
  readonly show3d = computed(() => this.allowed().has(THREE_D_VIEW_MODULE_ID));
  readonly showSelection = computed(() => this.allowed().has(SELECTION_TOOL_MODULE_ID) && !this.mapService.is3d());
  readonly showZoomIn = computed(() => this.allowed().has(ZOOM_IN_MODULE_ID));
  readonly showZoomOut = computed(() => this.allowed().has(ZOOM_OUT_MODULE_ID));
  readonly showResetView = computed(() => this.allowed().has(RESET_VIEW_MODULE_ID));
  readonly showFullscreen = computed(() => this.allowed().has(FULLSCREEN_MODULE_ID));
  readonly showIdentify = computed(() => this.allowed().has(INFORMATION_TOOL_MODULE_ID) && !this.mapService.is3d());
  readonly identifyActive = this.mapService.identifyActive;

  toggleIdentify(): void {
    this.mapService.toggleIdentify();
  }
  readonly showNavGroup = computed(
    () => this.showZoomIn() || this.showZoomOut() || this.showResetView() || this.showFullscreen()
  );

  /** Shape currently being drawn by the Selection Tool (owned by the
   *  Attribute Table), so the matching button shows as active. */
  @Input() selectingShape: SelectShape | null = null;
  @Output() selectRequest = new EventEmitter<{ shape: SelectShape; mode: SelectMode }>();
  /** Number of features currently selected (enables Clear selection). */
  @Input() selectedCount = 0;
  @Output() clearSelectionRequest = new EventEmitter<void>();
  /** Reset clicked — the workspace resets the map and every tool. */
  @Output() resetRequest = new EventEmitter<void>();

  /** Inline SVG icons (24×24 viewBox) — PrimeIcons has no polygon or
   *  lasso glyph. Dashed outlines read as "selection" like desktop GIS. */
  readonly selectShapes: { shape: SelectShape; label: string; path: string }[] = [
    { shape: 'Rectangle', label: 'Select by rectangle', path: 'M4 5h16v14H4z' },
    { shape: 'Polygon', label: 'Select by polygon', path: 'M12 3l8.5 6.2-3.2 9.8H6.7L3.5 9.2z' },
    {
      shape: 'Lasso',
      label: 'Select by lasso',
      path: 'M12 4c4.97 0 9 2.46 9 5.5S16.97 15 12 15c-1.3 0-2.54-.17-3.66-.47M7.2 13.9C4.7 12.9 3 11.3 3 9.5 3 6.46 7.03 4 12 4M7.2 13.9c-.9.7-1.2 1.8-.6 2.8.7 1.1 2.3 1.4 3.4.7M10 17.4c.3 1.2-.2 2.4-1.3 3.1'
    }
  ];
  private readonly selectModes: { value: SelectMode; label: string; icon: string }[] = [
    { value: 'new', label: 'New selection', icon: 'pi pi-circle' },
    { value: 'add', label: 'Add to selection', icon: 'pi pi-plus-circle' },
    { value: 'remove', label: 'Remove from selection', icon: 'pi pi-minus-circle' }
  ];
  private readonly selectModeIndex = signal(0);
  readonly selectMode = computed(() => this.selectModes[this.selectModeIndex()]);

  cycleSelectMode(): void {
    this.selectModeIndex.update((i) => (i + 1) % this.selectModes.length);
  }

  select(shape: SelectShape): void {
    this.selectRequest.emit({ shape, mode: this.selectMode().value });
  }
  readonly canGoBack = this.mapService.canGoBack;
  readonly canGoForward = this.mapService.canGoForward;

  @ViewChild('gotoPopover') private gotoPopover?: Popover;

  private readonly crsService = inject(CrsService);
  readonly otherCrs = OTHER_CRS;
  readonly coordinateSystems = [...GOTO_COORDINATE_SYSTEMS, { code: OTHER_CRS, label: 'Any other CRS…' }];
  readonly crs = signal(GOTO_COORDINATE_SYSTEMS[0].code);
  /** The "Any other CRS…" choice (any EPSG system). */
  readonly otherCode = signal('');
  private readonly otherInfo = signal<CrsInfo | null>(null);
  readonly xInput = signal('');
  readonly yInput = signal('');
  readonly gotoError = signal<string | null>(null);
  readonly gotoResult = signal<string | null>(null);

  readonly crsOption = computed((): CoordinateSystemOption => {
    const other = this.otherInfo();
    if (this.crs() === OTHER_CRS && other) {
      const geographic = other.kind === 'geographic';
      return {
        code: other.code,
        label: other.name,
        axes: geographic ? ['Longitude', 'Latitude'] : ['Easting (X)', 'Northing (Y)'],
        geographic
      };
    }
    return GOTO_COORDINATE_SYSTEMS.find((c) => c.code === this.crs()) ?? GOTO_COORDINATE_SYSTEMS[0];
  });

  setOtherCrs(code: string): void {
    this.otherCode.set(code);
    this.otherInfo.set(null);
    this.gotoError.set(null);
    if (code) this.crsService.get(code).subscribe({ next: (crs) => this.otherInfo.set(crs), error: () => undefined });
  }

  zoomIn(): void {
    this.mapService.zoomIn();
  }

  zoomOut(): void {
    this.mapService.zoomOut();
  }

  resetView(): void {
    this.resetRequest.emit();
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
    if (this.crs() === OTHER_CRS && !this.otherInfo()) {
      this.gotoError.set('Choose the coordinate system.');
      return;
    }
    // Systems beyond the built-in ones get their proj4 definition first.
    this.crsService.ensureRegistered(option.code).subscribe({
      next: (ok) => {
        const lonLat = ok ? this.mapService.goToCoordinate(x, y, option.code) : null;
        if (!lonLat) {
          this.gotoError.set(ok ? 'That coordinate is outside the selected coordinate system.' : 'This coordinate system cannot be used here.');
          return;
        }
        this.gotoResult.set(`Lon ${lonLat[0].toFixed(6)}, Lat ${lonLat[1].toFixed(6)}`);
      },
      error: () => this.gotoError.set('Could not load the coordinate system.')
    });
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
