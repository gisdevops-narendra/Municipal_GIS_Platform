import { Component, DestroyRef, Input, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AnalyticsField } from '../../../../core/models/layer-analytics.model';
import { GisLayersService } from '../../../../core/services/gis-layers.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { MapService } from '../../services/map.service';

type Status = 'falling-fast' | 'falling' | 'stable' | 'rising' | 'no-data';

interface Well {
  id: number;
  label: string;
  point: [number, number];
  readings: number;
  latestDepthM: number | null;
  latestDate: string | null;
  trendMPerYear: number | null;
  status: Status;
}

interface Summary {
  layerName: string;
  wells: Well[];
  stats: { wells: number; withReadings: number; fallingFast: number; falling: number; stable: number; rising: number; averageDepthM: number | null };
  truncated: boolean;
}

interface Reading {
  id: string;
  date: string;
  depthM: number;
  note: string | null;
}

const STATUS: Record<Status, { label: string; color: string }> = {
  'falling-fast': { label: 'Falling fast', color: '#dc2626' },
  falling: { label: 'Falling', color: '#f97316' },
  stable: { label: 'Stable', color: '#2563eb' },
  rising: { label: 'Rising', color: '#16a34a' },
  'no-data': { label: 'No readings', color: '#9ca3af' }
};

/** Groundwater: borewells on any point layer, dated water-level readings,
 *  trend per well (m / year) and a map coloured by trend. */
@Component({
  selector: 'app-groundwater',
  standalone: true,
  imports: [FormsModule, ButtonModule, DatePipe],
  styleUrl: './extras.scss',
  template: `
    <div class="px">
      @if (!pointLayers().length) {
        <p class="px__hint">No point layer for wells. Upload or draw a point layer of borewells first.</p>
      } @else {
      @if (selected(); as w) {
        <!-- ===== One well ===== -->
        <button type="button" class="px__link-btn" style="align-self: flex-start" (click)="closeWell()"><i class="pi pi-arrow-left"></i>All wells</button>
        <div>
          <div class="px__item-title" style="font-size: 15px">{{ w.label }}</div>
          <span class="px__item-sub" [style.color]="statusOf(w.status).color">{{ statusOf(w.status).label }}@if (w.trendMPerYear !== null) { · {{ w.trendMPerYear > 0 ? '+' : '' }}{{ w.trendMPerYear }} m/year }</span>
        </div>

        @if (readings().length > 1) {
          <div class="px__section">
            <h4>Depth to water (m below ground)</h4>
            <svg viewBox="0 0 300 120" style="width: 100%; height: 130px; background: var(--color-surface-alt); border-radius: var(--radius-md)" role="img" aria-label="Water level history">
              <polyline [attr.points]="chart().line" fill="none" stroke="#2563eb" stroke-width="2" />
              @for (p of chart().dots; track $index) { <circle [attr.cx]="p[0]" [attr.cy]="p[1]" r="2.5" fill="#2563eb" /> }
              <text x="4" y="12" font-size="9" fill="currentColor" opacity="0.6">{{ chart().min }} m</text>
              <text x="4" y="116" font-size="9" fill="currentColor" opacity="0.6">{{ chart().max }} m</text>
            </svg>
            <span class="px__item-sub">Lower line = deeper water. {{ readings()[0].date | date: 'MMM y' }} – {{ readings()[readings().length - 1].date | date: 'MMM y' }}</span>
          </div>
        }

        <div class="px__card">
          <span class="px__label">Add reading</span>
          <div class="px__row">
            <label class="px__field"><span class="px__label">Date</span>
              <input class="px__input" type="date" [max]="today" [ngModel]="newDate()" (ngModelChange)="newDate.set($event)" /></label>
            <label class="px__field"><span class="px__label">Depth (m)</span>
              <input class="px__input" type="number" step="0.01" [ngModel]="newDepth()" (ngModelChange)="newDepth.set($event)" placeholder="e.g. 18.4" /></label>
          </div>
          <input class="px__input" maxlength="500" [ngModel]="newNote()" (ngModelChange)="newNote.set($event)" placeholder="Note (optional): pre-monsoon, pump on…" />
          <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-plus" label="Save reading" [loading]="busy()"
                  [disabled]="!newDate() || newDepth() === null || newDepth() === ''" (click)="addReading(w)"></button>
        </div>

        <div class="px__list">
          @for (r of readingsDesc(); track r.id) {
            <div class="px__item">
              <div class="px__item-main">
                <span class="px__item-title">{{ r.depthM }} m</span>
                <span class="px__item-sub">{{ r.date | date: 'mediumDate' }}@if (r.note) { · {{ r.note }} }</span>
              </div>
              <button type="button" class="px__icon-btn px__icon-btn--danger" title="Delete reading" (click)="deleteReading(w, r)"><i class="pi pi-trash"></i></button>
            </div>
          } @empty {
            <p class="px__hint px__hint--center">No readings yet.</p>
          }
        </div>
      } @else {
        <!-- ===== All wells ===== -->
        <p class="px__intro">Track borewell water levels over time. Wells turn red where the water table is falling fastest.</p>
        <label class="px__field"><span class="px__label">Well layer</span>
          <select class="px__native-select" [ngModel]="layerId()" (ngModelChange)="pickLayer($event)">
            @for (l of pointLayers(); track l.id) { <option [value]="l.id">{{ l.name }}</option> }
          </select></label>

        @if (summary(); as s) {
          <div class="px__card">
            <dl class="px__kv">
              <dt>Wells</dt><dd>{{ s.stats.wells }} ({{ s.stats.withReadings }} with readings)</dd>
              @if (s.stats.averageDepthM !== null) { <dt>Average latest depth</dt><dd>{{ s.stats.averageDepthM }} m</dd> }
            </dl>
            <div class="px__secret" style="flex-wrap: wrap; gap: 6px">
              @for (k of statusKeys; track k) {
                <button type="button" class="px__badge" style="cursor: pointer" [style.border-color]="statusOf(k).color" [style.color]="statusOf(k).color"
                        [style.font-weight]="filter() === k ? 700 : 400" (click)="filter.set(filter() === k ? '' : k)">
                  {{ statusOf(k).label }} {{ countOf(k) }}
                </button>
              }
            </div>
          </div>
          <input class="px__input" type="search" placeholder="Search wells…" [ngModel]="query()" (ngModelChange)="query.set($event)" />
          <div class="px__list">
            @for (w of visibleWells(); track w.id) {
              <div class="px__item px__item--click" (click)="openWell(w)">
                <i class="pi pi-circle-fill" style="font-size: 9px" [style.color]="statusOf(w.status).color"></i>
                <div class="px__item-main">
                  <span class="px__item-title">{{ w.label }}</span>
                  <span class="px__item-sub">{{ w.latestDepthM !== null ? w.latestDepthM + ' m · ' + (w.latestDate | date: 'd MMM y') : 'no readings' }}</span>
                </div>
                @if (w.trendMPerYear !== null) { <span class="px__mono" [style.color]="statusOf(w.status).color">{{ w.trendMPerYear > 0 ? '+' : '' }}{{ w.trendMPerYear }}</span> }
              </div>
            } @empty {
              <p class="px__hint px__hint--center">No well matches.</p>
            }
          </div>
          <button pButton type="button" class="p-button-sm p-button-outlined px__btn-block" icon="pi pi-map-marker" label="Open the well I click on the map" (click)="pickWell()"></button>

          <details class="px__card">
            <summary style="cursor: pointer; font-weight: 600; font-size: 12.5px">Import readings from CSV</summary>
            <p class="px__hint">Columns: well id, date (YYYY-MM-DD), depth in metres — with a header row.</p>
            <label class="px__field"><span class="px__label">Well id matches layer field</span>
              <select class="px__native-select" [ngModel]="keyField()" (ngModelChange)="keyField.set($event)">
                <option value="feat_id">Feature id (feat_id)</option>
                @for (f of fields(); track f.name) { <option [value]="f.name">{{ f.name }}</option> }
              </select></label>
            <input type="file" accept=".csv,text/csv" (change)="readCsv($event)" />
            @if (csvRows().length) {
              <span class="px__item-sub">{{ csvRows().length }} rows read.</span>
              <button pButton type="button" class="p-button-sm px__btn-block" icon="pi pi-upload" label="Import" [loading]="busy()" (click)="importCsv()"></button>
            }
          </details>
          <p class="px__hint">Trend = straight-line fit of the last 3 years; + means the water is getting deeper. Falling fast &gt; 0.5 m/year.</p>
        } @else if (busy()) {
          <p class="px__hint">Loading wells…</p>
        }
      }
      }
    </div>
  `
})
export class GroundwaterComponent {
  private readonly http = inject(HttpClient);
  private readonly map = inject(MapService);
  private readonly layersApi = inject(GisLayersService);
  private readonly notify = inject(NotificationService);
  private readonly api = `${environment.apiUrl}/gis/groundwater`;

  @Input() set layers(value: GisLayer[] | null) {
    this.layersSignal.set(value ?? []);
    if (!this.layerId() && this.pointLayers().length) {
      const guess = this.pointLayers().find((l) => /well|bore|tube|hand.?pump|piezo/i.test(l.name)) ?? this.pointLayers()[0];
      this.pickLayer(guess.id);
    }
  }
  private readonly layersSignal = signal<GisLayer[]>([]);
  readonly pointLayers = computed(() => this.layersSignal().filter((l) => l.layerType === 'VECTOR' && l.geometryType === 'POINT'));

  readonly statusKeys: Status[] = ['falling-fast', 'falling', 'stable', 'rising', 'no-data'];
  readonly today = new Date().toISOString().slice(0, 10);
  readonly layerId = signal('');
  readonly summary = signal<Summary | null>(null);
  readonly fields = signal<AnalyticsField[]>([]);
  readonly busy = signal(false);
  readonly filter = signal<Status | ''>('');
  readonly query = signal('');
  readonly selected = signal<Well | null>(null);
  readonly readings = signal<Reading[]>([]);
  readonly readingsDesc = computed(() => [...this.readings()].reverse());
  readonly newDate = signal(this.today);
  readonly newDepth = signal<number | string | null>(null);
  readonly newNote = signal('');
  readonly keyField = signal('feat_id');
  readonly csvRows = signal<{ key: string; date: string; depthM: number }[]>([]);

  readonly visibleWells = computed(() => {
    const q = this.query().trim().toLowerCase();
    const f = this.filter();
    const order: Record<Status, number> = { 'falling-fast': 0, falling: 1, stable: 2, rising: 3, 'no-data': 4 };
    return (this.summary()?.wells ?? [])
      .filter((w) => (!f || w.status === f) && (!q || w.label.toLowerCase().includes(q)))
      .sort((a, b) => order[a.status] - order[b.status] || (b.trendMPerYear ?? 0) - (a.trendMPerYear ?? 0))
      .slice(0, 300);
  });

  readonly chart = computed(() => {
    const list = this.readings();
    if (list.length < 2) return { line: '', dots: [] as number[][], min: 0, max: 0 };
    const t0 = Date.parse(list[0].date);
    const t1 = Date.parse(list[list.length - 1].date);
    const depths = list.map((r) => r.depthM);
    const min = Math.min(...depths);
    const max = Math.max(...depths);
    const x = (t: number) => 30 + ((t - t0) / Math.max(1, t1 - t0)) * 262;
    // Depth grows downward, like the water table.
    const y = (d: number) => 10 + ((d - min) / Math.max(0.01, max - min)) * 100;
    const dots = list.map((r) => [Math.round(x(Date.parse(r.date)) * 10) / 10, Math.round(y(r.depthM) * 10) / 10]);
    return { line: dots.map((p) => p.join(',')).join(' '), dots, min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10 };
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.map.setFilledAreas(null));
  }

  statusOf = (s: Status) => STATUS[s];
  countOf = (s: Status) => (this.summary()?.wells ?? []).filter((w) => w.status === s).length;

  pickLayer(id: string): void {
    this.layerId.set(id);
    this.selected.set(null);
    this.load();
    this.layersApi.analyticsFields(id).subscribe((f) => this.fields.set(f.filter((x) => x.kind === 'string' || x.kind === 'number')));
  }

  private load(): void {
    this.busy.set(true);
    this.http.get<Summary>(`${this.api}/${this.layerId()}`).subscribe({
      next: (s) => {
        this.summary.set(s);
        this.busy.set(false);
        this.draw();
      },
      error: (e) => {
        this.busy.set(false);
        this.notify.error(e?.error?.message ?? 'Could not load the wells.');
      }
    });
  }

  private draw(): void {
    const wells = this.summary()?.wells ?? [];
    const groups = new Map<Status, [number, number][]>();
    for (const w of wells) groups.set(w.status, [...(groups.get(w.status) ?? []), w.point]);
    this.map.setFilledAreas(
      [...groups.entries()].map(([s, pts]) => ({ geometry: { type: 'MultiPoint', coordinates: pts }, color: STATUS[s].color, radius: s === 'falling-fast' ? 7 : 5 }))
    );
  }

  openWell(w: Well): void {
    this.selected.set(w);
    this.readings.set([]);
    this.map.zoomToGeometries([{ type: 'Point', coordinates: w.point }]);
    this.http.get<Reading[]>(`${this.api}/${this.layerId()}/wells/${w.id}/readings`).subscribe((r) => this.readings.set(r));
  }

  closeWell(): void {
    this.selected.set(null);
    this.load();
  }

  /** Nearest well to a map click (within ~ 30 px). */
  pickWell(): void {
    this.map.pickMapPoint().subscribe(({ lonLat, toleranceM }) => {
      const wells = this.summary()?.wells ?? [];
      const k = 111_320 * Math.cos((lonLat[1] * Math.PI) / 180);
      let best: Well | null = null;
      let bestD = Infinity;
      for (const w of wells) {
        const d = Math.hypot((w.point[0] - lonLat[0]) * k, (w.point[1] - lonLat[1]) * 110_540);
        if (d < bestD) {
          bestD = d;
          best = w;
        }
      }
      if (best && bestD <= toleranceM * 4) this.openWell(best);
      else this.notify.info('No well there — click closer to a well.');
    });
  }

  addReading(w: Well): void {
    this.busy.set(true);
    this.http
      .post<Reading[]>(`${this.api}/${this.layerId()}/wells/${w.id}/readings`, {
        date: this.newDate(),
        depthM: Number(this.newDepth()),
        note: this.newNote().trim() || undefined
      })
      .subscribe({
        next: (r) => {
          this.readings.set(r);
          this.newDepth.set(null);
          this.newNote.set('');
          this.busy.set(false);
        },
        error: (e) => {
          this.busy.set(false);
          const m = e?.error?.message;
          this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Could not save the reading.');
        }
      });
  }

  deleteReading(w: Well, r: Reading): void {
    this.http.delete(`${this.api}/${this.layerId()}/readings/${r.id}`).subscribe({
      next: () => this.readings.update((list) => list.filter((x) => x.id !== r.id)),
      error: (e) => this.notify.error(e?.error?.message ?? 'Could not delete the reading.')
    });
  }

  readCsv(event: Event): void {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (!file) return;
    void file.text().then((text) => {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      const rows = lines.slice(1).map((line) => {
        const [key, date, depth] = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
        return { key: key ?? '', date: date ?? '', depthM: Number(depth) };
      });
      this.csvRows.set(rows.slice(0, 20000));
    });
  }

  importCsv(): void {
    this.busy.set(true);
    this.http
      .post<{ imported: number; skipped: number; problems: string[] }>(`${this.api}/${this.layerId()}/import`, {
        keyField: this.keyField(),
        rows: this.csvRows()
      })
      .subscribe({
        next: (r) => {
          this.busy.set(false);
          this.csvRows.set([]);
          if (r.skipped) this.notify.warn(`${r.imported} imported, ${r.skipped} skipped (${r.problems.slice(0, 3).join('; ')}).`);
          else this.notify.success(`${r.imported} readings imported.`);
          this.load();
        },
        error: (e) => {
          this.busy.set(false);
          const m = e?.error?.message;
          this.notify.error(Array.isArray(m) ? m.join(', ') : m ?? 'Import failed.');
        }
      });
  }
}
