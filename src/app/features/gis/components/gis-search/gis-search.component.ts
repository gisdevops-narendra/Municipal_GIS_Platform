import { Component, ElementRef, EventEmitter, HostListener, Output, inject, signal } from '@angular/core';
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

  readonly query = signal('');
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

  featureLabel(match: GisSearchFeatureMatch): string {
    const values = Object.values(match.attributes).find((v) => typeof v === 'string' && v.trim().length > 0);
    return typeof values === 'string' ? values : match.layerName;
  }
}
