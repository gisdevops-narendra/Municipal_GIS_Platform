import { Component, ElementRef, EventEmitter, HostListener, Output, computed, inject, signal } from '@angular/core';
import { MapService } from '../../services/map.service';
import { parseGeographicInput } from '../map-controls/map-controls.component';
import { FormsModule } from '@angular/forms';
import { InputTextModule } from 'primeng/inputtext';
import { ButtonModule } from 'primeng/button';
import { Subject } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, of, switchMap } from 'rxjs';
import { GisDashboardService } from '../../../../core/services/gis-dashboard.service';
import { GisSearchFeatureMatch, GisSearchLayerMatch, GisSearchResult } from '../../../../core/models/gis-dashboard.model';

const EMPTY_RESULT: GisSearchResult = { layers: [], features: [] };
const MIN_QUERY_LENGTH = 2;

/**
 * Task 9 §5: a deliberately lightweight search over layer names/codes and
 * a bounded set of feature attributes (road name, ward name, layer name)
 * — NOT a property/cadastral search system. Every result is already
 * VIEW-authorized (GisDashboardService.search is permission-filtered
 * server-side); this component just renders what comes back and lets the
 * parent page act on a click (show the layer / zoom to the feature).
 */
@Component({
  selector: 'app-gis-search',
  standalone: true,
  imports: [FormsModule, InputTextModule, ButtonModule],
  templateUrl: './gis-search.component.html',
  styleUrl: './gis-search.component.scss'
})
export class GisSearchComponent {
  private readonly gisDashboardService = inject(GisDashboardService);
  private readonly host = inject(ElementRef<HTMLElement>);

  @Output() layerSelected = new EventEmitter<GisSearchLayerMatch>();
  @Output() featureSelected = new EventEmitter<GisSearchFeatureMatch>();
  /** × pressed — the parent removes what the search put on the map. */
  @Output() cleared = new EventEmitter<void>();

  readonly query = signal('');
  private readonly mapService = inject(MapService);

  /** A coordinate typed into the box ([lon, lat]), e.g. "22.30, 73.18",
   *  "73.18 22.30" or "22°18'N 73°10'E". Plain number pairs are read as
   *  "lat, lon" (as Google Maps writes them) unless the first is > 90. */
  readonly coordinate = computed<[number, number] | null>(() => {
    const text = this.query().trim();
    if (!/\d/.test(text) || /[a-df-mo-rt-vx-z]{2,}/i.test(text)) return null;
    if (/[°'"′″NSEW]/i.test(text)) {
      const geo = parseGeographicInput(text, '');
      return geo && Math.abs(geo[0]) <= 180 && Math.abs(geo[1]) <= 90 ? geo : null;
    }
    const parts = text.split(/[\s,;]+/).filter(Boolean);
    if (parts.length !== 2 || !parts.every((p) => /^[-+]?\d+(\.\d+)?$/.test(p))) return null;
    const [a, b] = parts.map(Number);
    const [lon, lat] = Math.abs(a) > 90 && Math.abs(b) <= 90 ? [a, b] : [b, a];
    return Math.abs(lon) <= 180 && Math.abs(lat) <= 90 ? [lon, lat] : null;
  });

  /** For a plain pair where both numbers could be a latitude, the other
   *  reading too (so "73.18 22.30" also offers 22.30 N, 73.18 E). */
  readonly altCoordinate = computed<[number, number] | null>(() => {
    const c = this.coordinate();
    if (!c || /[°'"′″NSEW]/i.test(this.query())) return null;
    const [lon, lat] = c;
    return Math.abs(lon) <= 90 && lon !== lat ? [lat, lon] : null;
  });

  goToCoordinate(c: [number, number] | null = this.coordinate()): void {
    if (!c) return;
    this.mapService.goToCoordinate(c[0], c[1], 'EPSG:4326');
    this.open.set(false);
  }

  coordinateLabel(c: [number, number]): string {
    return `${Math.abs(c[1]).toFixed(5)}° ${c[1] < 0 ? 'S' : 'N'}, ${Math.abs(c[0]).toFixed(5)}° ${c[0] < 0 ? 'W' : 'E'}`;
  }
  readonly loading = signal(false);
  readonly open = signal(false);
  readonly result = signal<GisSearchResult>(EMPTY_RESULT);

  private readonly query$ = new Subject<string>();

  constructor() {
    this.query$
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((q) => {
          if (q.trim().length < MIN_QUERY_LENGTH) {
            this.loading.set(false);
            return of(EMPTY_RESULT);
          }
          this.loading.set(true);
          return this.gisDashboardService.search(q).pipe(catchError(() => of(EMPTY_RESULT)));
        })
      )
      .subscribe((result) => {
        this.loading.set(false);
        this.result.set(result);
      });
  }

  onInput(value: string): void {
    this.query.set(value);
    this.open.set(value.trim().length >= MIN_QUERY_LENGTH);
    this.query$.next(value);
  }

  onFocus(): void {
    if (this.query().trim().length >= MIN_QUERY_LENGTH) {
      this.open.set(true);
    }
  }

  /** Dismiss the results dropdown on an outside click or Escape, so it
   *  doesn't stay stuck open over the map. */
  @HostListener('document:pointerdown', ['$event'])
  onDocumentPointerDown(event: Event): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) {
      this.open.set(false);
    }
  }

  @HostListener('keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }

  clear(): void {
    this.query.set('');
    this.open.set(false);
    this.result.set(EMPTY_RESULT);
    // Keep the stream in step: otherwise typing the same text again after
    // Clear is swallowed by distinctUntilChanged and nothing is searched.
    this.query$.next('');
    this.cleared.emit();
  }

  selectLayer(match: GisSearchLayerMatch): void {
    this.layerSelected.emit(match);
    this.open.set(false);
  }

  selectFeature(match: GisSearchFeatureMatch): void {
    this.featureSelected.emit(match);
    this.open.set(false);
  }

  hasResults(): boolean {
    const r = this.result();
    return r.layers.length > 0 || r.features.length > 0;
  }

  /** The value that matched the query (e.g. the village name), else the
   *  first name-like / text value — never a bare id. */
  featureLabel(match: GisSearchFeatureMatch): string {
    if (match.label) return match.label;
    const q = this.query().trim().toLowerCase();
    const entries = Object.entries(match.attributes).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1].trim().length > 0
    );
    const hit =
      entries.find(([, v]) => v.toLowerCase().includes(q)) ??
      entries.find(([k]) => /name/i.test(k)) ??
      entries.find(([k]) => !/(^|_)(id|fid|gid|code)$|^objectid/i.test(k));
    return hit?.[1] ?? match.layerName;
  }
}
