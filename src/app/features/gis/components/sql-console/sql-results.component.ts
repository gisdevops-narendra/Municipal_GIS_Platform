import { DecimalPipe } from '@angular/common';
import { Component, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { MenuItem } from 'primeng/api';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { MenuModule } from 'primeng/menu';
import { ContextMenu, ContextMenuModule } from 'primeng/contextmenu';
import GeoJSON from 'ol/format/GeoJSON';
import WKT from 'ol/format/WKT';
import { NotificationService } from '../../../../core/services/notification.service';
import { SqlColumn, SqlConsoleStore, SqlView, colorScale, legendFor } from './sql-console.store';

type ChartKind = 'bar' | 'pie' | 'histogram';
const COUNT = '(count)';
const MAX_SHOWN = 2000;

/** Results of the active SQL Console tab: table, chart, plan and map style,
 *  with save-as-layer and export. Lives in the bottom dock and the workbench. */
@Component({
  selector: 'app-sql-results',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, DialogModule, MenuModule, ContextMenuModule],
  template: `
    @if (store.active(); as tab) {
      <div class="sr" [class.sr--compact]="compact()">
        <header class="sr__bar">
          <nav class="sr__views" role="tablist">
            @for (v of views; track v.id) {
              <button type="button" role="tab" class="sr__view" [class.is-on]="tab.view === v.id" [attr.aria-selected]="tab.view === v.id"
                      [disabled]="v.id === 'plan' ? !tab.plan : !tab.result || (v.id === 'style' && !tab.result.geometryColumn)"
                      (click)="setView(v.id)">
                <i [class]="v.icon" aria-hidden="true"></i><span>{{ v.label }}</span>
              </button>
            }
          </nav>
          @if (tab.result; as r) {
            <span class="sr__meta">
              <b>{{ r.rows.length | number }}</b>{{ r.truncated ? '+' : '' }} rows · {{ r.ms | number }} ms
              @if (r.truncated) { <span class="sr__warn" title="More rows matched — raise Max rows or add a WHERE">limit {{ r.limit | number }}</span> }
            </span>
            <span class="sr__actions">
              @if (r.geometryColumn && r.rows.length) {
                <button type="button" class="sr__btn" (click)="store.zoomToResult()"><i class="pi pi-search-plus"></i><span>Zoom</span></button>
                <button type="button" class="sr__btn sr__btn--primary" (click)="openSave()"><i class="pi pi-plus-circle"></i><span>Save as layer</span></button>
              }
              @if (r.rows.length) {
                <button type="button" class="sr__btn" [disabled]="exporting()" (click)="exportMenu.toggle($event)">
                  <i class="pi" [class.pi-download]="!exporting()" [class.pi-spin]="exporting()" [class.pi-spinner]="exporting()"></i><span>Export</span><i class="pi pi-angle-down sr__caret"></i>
                </button>
                <p-menu #exportMenu [model]="exportItems()" [popup]="true" appendTo="body" />
                <p-contextMenu #ctxMenu [model]="ctxItems()" appendTo="body" />
              }
              <button type="button" class="sr__btn sr__btn--icon" title="Clear results" aria-label="Clear results" (click)="clear()"><i class="pi pi-times"></i></button>
            </span>
          }
        </header>

        @if (tab.error; as e) {
          <div class="sr__error" role="alert"><i class="pi pi-exclamation-circle"></i><span>{{ e.message }}</span></div>
        }

        <div class="sr__body">
          @switch (tab.view) {
            @case ('table') {
              @if (tab.result; as r) {
                @if (r.rows.length) {
                  <div class="sr__tools">
                    <label class="sr__filter">
                      <i class="pi pi-filter" aria-hidden="true"></i>
                      <input type="search" placeholder="Filter rows…" [ngModel]="filter()" (ngModelChange)="filter.set($event)" aria-label="Filter rows" />
                    </label>
                    @if (filter() || sort()) {
                      <span class="sr__muted">{{ viewRows().length | number }} shown</span>
                    }
                    <span class="sr__tools-right">
                      <span class="sr__muted sr__tip"><i class="pi pi-info-circle"></i> Right-click a cell or header for more</span>
                      <button type="button" class="sr__btn" (click)="copyAll()" title="Copy the rows shown (with headers) — paste into Excel">
                        <i class="pi pi-copy"></i><span>Copy all</span>
                      </button>
                    </span>
                  </div>
                  <div class="sr__grid">
                    <table>
                      <thead>
                        <tr>
                          <th class="sr__rn">#</th>
                          @for (c of r.columns; track c.name) {
                            <th [class.sr__num]="isNumeric(c.type)" (click)="toggleSort(c.name)" [attr.aria-sort]="sortState(c.name)"
                                (contextmenu)="openHeaderMenu($event, c)">
                              <span class="sr__th">
                                {{ c.name }}
                                @if (sort()?.col === c.name) { <i class="pi" [class.pi-sort-amount-up-alt]="sort()!.dir === 1" [class.pi-sort-amount-down]="sort()!.dir === -1"></i> }
                              </span>
                              <small>{{ shortType(c) }}</small>
                            </th>
                          }
                        </tr>
                      </thead>
                      <tbody>
                        @for (item of shownRows(); track item.i) {
                          <tr [class.is-picked]="picked() === item.i" class="sr__click" (click)="pick(item.i)" [attr.aria-selected]="picked() === item.i">
                            <td class="sr__rn">
                              <span class="sr__rn-num">{{ item.i + 1 }}</span>
                              <span class="sr__rowacts">
                                <button type="button" title="Copy row" aria-label="Copy row" (click)="$event.stopPropagation(); copyRow(item.row)"><i class="pi pi-copy"></i></button>
                                @if (r.geometryColumn) {
                                  <button type="button" title="Zoom to feature" aria-label="Zoom to feature" (click)="$event.stopPropagation(); store.zoomToResult(item.i)"><i class="pi pi-search-plus"></i></button>
                                }
                              </span>
                            </td>
                            @for (c of r.columns; track c.name) {
                              @let v = item.row[c.name];
                              <td [class.sr__num]="isNumeric(c.type)" [class.sr__null]="v === null || v === undefined" [title]="c.geometry ? '' : cell(v, c.type, true)"
                                  (contextmenu)="openCellMenu($event, item.row, item.i, c)">
                                @if (c.geometry) { <span class="sr__geom">{{ geomLabel(v) }}</span> } @else { {{ cell(v, c.type) }} }
                              </td>
                            }
                          </tr>
                        }
                      </tbody>
                    </table>
                  </div>
                  @if (viewRows().length > shownRows().length) {
                    <p class="sr__muted sr__foot">Showing the first {{ shownRows().length | number }} rows — export for all of them.</p>
                  }
                } @else {
                  <div class="sr__empty"><i class="pi pi-inbox"></i>The query ran but returned no rows.</div>
                }
              } @else if (!tab.error) {
                <div class="sr__empty"><i class="pi pi-play-circle"></i>Run a query (Ctrl + Enter) to see results here.</div>
              }
            }

            @case ('chart') {
              @if (tab.result; as r) {
                <div class="sr__chart">
                  <div class="sr__form">
                    <label>Chart
                      <select [ngModel]="chartKind()" (ngModelChange)="chartKind.set($event)">
                        <option value="bar">Bar</option><option value="pie">Pie</option><option value="histogram">Histogram</option>
                      </select>
                    </label>
                    @if (chartKind() !== 'histogram') {
                      <label>Group by
                        <select [ngModel]="chartX()" (ngModelChange)="chartX.set($event)">
                          @for (c of plainColumns(); track c.name) { <option [value]="c.name">{{ c.name }}</option> }
                        </select>
                      </label>
                    }
                    <label>{{ chartKind() === 'histogram' ? 'Values' : 'Measure' }}
                      <select [ngModel]="chartY()" (ngModelChange)="chartY.set($event)">
                        @if (chartKind() !== 'histogram') { <option [value]="COUNT">Count of rows</option> }
                        @for (c of numericColumns(); track c.name) { <option [value]="c.name">{{ chartKind() === 'histogram' ? c.name : 'Sum of ' + c.name }}</option> }
                      </select>
                    </label>
                  </div>
                  @if (chartData(); as d) {
                    @if (!d.length) {
                      <div class="sr__empty"><i class="pi pi-chart-bar"></i>Pick a numeric column to chart.</div>
                    } @else if (chartKind() === 'pie') {
                      <div class="sr__pie">
                        <svg viewBox="-1.05 -1.05 2.1 2.1" class="sr__pie-svg" role="img" aria-label="Pie chart">
                          @for (s of pieSlices(); track s.label) {
                            <path [attr.d]="s.path" [attr.fill]="s.color" stroke="var(--color-surface)" stroke-width="0.012"><title>{{ s.label }}: {{ s.value | number: '1.0-2' }} ({{ s.pct | number: '1.0-1' }}%)</title></path>
                          }
                        </svg>
                        <ul class="sr__legend">
                          @for (s of pieSlices(); track s.label) {
                            <li><span [style.background]="s.color"></span>{{ s.label }}<b>{{ s.pct | number: '1.0-1' }}%</b></li>
                          }
                        </ul>
                      </div>
                    } @else {
                      <div class="sr__bars">
                        @for (b of d; track b.label) {
                          <div class="sr__barrow" [title]="b.label + ': ' + (b.value | number: '1.0-2')">
                            <span class="sr__barlabel">{{ b.label }}</span>
                            <span class="sr__bartrack"><span class="sr__barfill" [style.width.%]="b.pct"></span></span>
                            <span class="sr__barval">{{ b.value | number: '1.0-2' }}</span>
                          </div>
                        }
                      </div>
                    }
                  }
                </div>
              }
            }

            @case ('plan') {
              @if (tab.plan; as p) {
                <div class="sr__plan">
                  <div class="sr__plan-sum">
                    <div><span>Estimated rows</span><b>{{ p.estimatedRows | number }}</b></div>
                    <div><span>Estimated cost</span><b>{{ p.totalCost | number: '1.0-0' }}</b></div>
                    <div><span>Speed</span><b [class]="'sr__speed sr__speed--' + speed(p.totalCost).cls">{{ speed(p.totalCost).label }}</b></div>
                  </div>
                  @for (h of p.hints; track h) { <div class="sr__hint"><i class="pi pi-lightbulb"></i>{{ h }}</div> }
                  @if (!p.hints.length) { <div class="sr__hint sr__hint--ok"><i class="pi pi-check-circle"></i>No obvious problems in this plan.</div> }
                  <ol class="sr__steps">
                    @for (l of p.lines; track $index) {
                      <li [style.padding-left.px]="12 + l.depth * 18">
                        <span class="sr__step">{{ l.depth ? '└ ' : '' }}{{ l.label }}</span>
                        <span class="sr__muted">~{{ l.rows | number: '1.0-0' }} rows · cost {{ l.cost | number: '1.0-0' }}</span>
                      </li>
                    }
                  </ol>
                </div>
              }
            }

            @case ('style') {
              @if (tab.result; as r) {
                <div class="sr__style">
                  <div class="sr__form">
                    <label>Colour by
                      <select [ngModel]="styleCol()" (ngModelChange)="styleCol.set($event)">
                        @for (c of plainColumns(); track c.name) { <option [value]="c.name">{{ c.name }}</option> }
                      </select>
                    </label>
                    <label>Label
                      <select [ngModel]="styleLabel()" (ngModelChange)="styleLabel.set($event)">
                        <option value="">None</option>
                        @for (c of plainColumns(); track c.name) { <option [value]="c.name">{{ c.name }}</option> }
                      </select>
                    </label>
                    <span class="sr__form-actions">
                      <button pButton type="button" class="p-button-sm" icon="pi pi-palette" label="Apply to map" [disabled]="!styleCol()" (click)="applyStyle()"></button>
                      @if (store.mapStyle()) {
                        <button pButton type="button" class="p-button-sm p-button-text" label="Reset" (click)="resetStyle()"></button>
                      }
                    </span>
                  </div>
                  @if (styleCol()) {
                    <ul class="sr__legend sr__legend--grid">
                      @for (item of legend(); track item.label) { <li><span [style.background]="item.color"></span>{{ item.label }}</li> }
                    </ul>
                  }
                </div>
              }
            }
          }
        </div>
      </div>

      <p-dialog [visible]="saveOpen()" (visibleChange)="saveOpen.set($event)" header="Save result as a layer" [modal]="true"
                [style]="{ width: '440px' }" [draggable]="false" appendTo="body">
        <div class="sr__dlg">
          <label>Layer name<input type="text" maxlength="120" [(ngModel)]="saveName" placeholder="e.g. Large wards" /></label>
          <label>Description <small>(optional)</small><textarea rows="3" maxlength="500" [(ngModel)]="saveDesc"></textarea></label>
          <p class="sr__muted">The whole query is run again (not only the rows shown) and saved as a new layer in the workspace's projection. One geometry type is kept — the most common one.</p>
          @if (saveError(); as e) { <p class="sr__error"><i class="pi pi-exclamation-circle"></i><span>{{ e }}</span></p> }
        </div>
        <ng-template #footer>
          <button pButton type="button" class="p-button-text" label="Cancel" (click)="saveOpen.set(false)"></button>
          <button pButton type="button" icon="pi pi-check" label="Create layer" [loading]="saving()" [disabled]="!saveName.trim()" (click)="save()"></button>
        </ng-template>
      </p-dialog>
    }
  `,
  styleUrl: './sql-results.component.scss'
})
export class SqlResultsComponent {
  readonly store = inject(SqlConsoleStore);
  private readonly notify = inject(NotificationService);
  /** Narrow layout (workbench side-by-side is wide; dock is wide too). */
  readonly compact = input(false);
  readonly COUNT = COUNT;

  readonly views: { id: SqlView; label: string; icon: string }[] = [
    { id: 'table', label: 'Table', icon: 'pi pi-table' },
    { id: 'chart', label: 'Chart', icon: 'pi pi-chart-bar' },
    { id: 'style', label: 'Style map', icon: 'pi pi-palette' },
    { id: 'plan', label: 'Plan', icon: 'pi pi-sitemap' }
  ];

  readonly filter = signal('');
  readonly sort = signal<{ col: string; dir: 1 | -1 } | null>(null);
  readonly picked = signal<number | null>(null);
  readonly exporting = signal(false);

  readonly chartKind = signal<ChartKind>('bar');
  readonly chartX = signal('');
  readonly chartY = signal(COUNT);
  readonly styleCol = signal('');
  readonly styleLabel = signal('');

  readonly saveOpen = signal(false);
  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  saveName = '';
  saveDesc = '';

  private readonly result = computed(() => this.store.active()?.result ?? null);
  readonly plainColumns = computed(() => (this.result()?.columns ?? []).filter((c) => !c.geometry));
  readonly numericColumns = computed(() => this.plainColumns().filter((c) => this.isNumeric(c.type)));

  /** Rows after filter and sort, keeping their original index. */
  readonly viewRows = computed(() => {
    const r = this.result();
    if (!r) return [];
    let rows = r.rows.map((row, i) => ({ row, i }));
    const q = this.filter().trim().toLowerCase();
    if (q) {
      const cols = r.columns.filter((c) => !c.geometry).map((c) => c.name);
      rows = rows.filter(({ row }) => cols.some((c) => String(row[c] ?? '').toLowerCase().includes(q)));
    }
    const s = this.sort();
    if (s) {
      rows = [...rows].sort((a, b) => {
        const x = a.row[s.col];
        const y = b.row[s.col];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * s.dir;
      });
    }
    return rows;
  });
  readonly shownRows = computed(() => this.viewRows().slice(0, MAX_SHOWN));

  readonly chartData = computed(() => {
    const r = this.result();
    if (!r) return [];
    const kind = this.chartKind();
    const y = this.chartY();
    if (kind === 'histogram') {
      const vals = r.rows.map((row) => row[y]).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
      if (!vals.length) return [];
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const bins = 12;
      const w = (max - min) / bins || 1;
      const counts = new Array(bins).fill(0);
      for (const v of vals) counts[Math.min(bins - 1, Math.floor((v - min) / w))]++;
      const top = Math.max(...counts);
      return counts.map((n, i) => ({
        label: `${fmtNum(min + i * w)} – ${fmtNum(min + (i + 1) * w)}`,
        value: n,
        pct: (n / top) * 100
      }));
    }
    const x = this.chartX();
    if (!x) return [];
    const sums = new Map<string, number>();
    for (const row of r.rows) {
      const key = String(row[x] ?? '(empty)');
      const add = y === COUNT ? 1 : typeof row[y] === 'number' ? (row[y] as number) : 0;
      sums.set(key, (sums.get(key) ?? 0) + add);
    }
    const sorted = [...sums.entries()].sort((a, b) => b[1] - a[1]);
    const top = sorted.slice(0, kind === 'pie' ? 8 : 25);
    if (kind === 'pie' && sorted.length > 8) top.push(['Other', sorted.slice(8).reduce((s, e) => s + e[1], 0)]);
    const maxV = Math.max(...top.map((e) => Math.abs(e[1])), 1);
    return top.map(([label, value]) => ({ label, value, pct: (Math.abs(value) / maxV) * 100 }));
  });

  readonly pieSlices = computed(() => {
    const data = this.chartData().filter((d) => d.value > 0);
    const total = data.reduce((s, d) => s + d.value, 0) || 1;
    const colors = colorScale(data.map((d) => d.label));
    let a0 = -Math.PI / 2;
    return data.map((d) => {
      const frac = d.value / total;
      const a1 = a0 + frac * Math.PI * 2;
      const large = frac > 0.5 ? 1 : 0;
      const path =
        frac >= 0.9999
          ? 'M 1 0 A 1 1 0 1 1 -1 0 A 1 1 0 1 1 1 0 Z'
          : `M 0 0 L ${Math.cos(a0)} ${Math.sin(a0)} A 1 1 0 ${large} 1 ${Math.cos(a1)} ${Math.sin(a1)} Z`;
      a0 = a1;
      return { label: d.label, value: d.value, pct: frac * 100, color: colors(d.label), path };
    });
  });

  readonly legend = computed(() => {
    const r = this.result();
    const col = this.styleCol();
    return r && col ? legendFor(r.rows.map((row) => row[col])) : [];
  });

  readonly exportItems = computed<MenuItem[]>(() => {
    const geo = !!this.result()?.geometryColumn;
    const item = (label: string, icon: string, format: 'csv' | 'xlsx' | 'geojson' | 'kml' | 'shapefile', disabled = false): MenuItem => ({
      label,
      icon,
      disabled,
      command: () => this.export(format)
    });
    return [
      item('CSV', 'pi pi-file', 'csv'),
      item('Excel (.xlsx)', 'pi pi-file-excel', 'xlsx'),
      { separator: true },
      item('GeoJSON', 'pi pi-map', 'geojson', !geo),
      item('Shapefile (.zip)', 'pi pi-box', 'shapefile', !geo),
      item('KML', 'pi pi-globe', 'kml', !geo)
    ];
  });

  constructor() {
    // New result → reset table state and pick sensible chart / style columns.
    effect(() => {
      const r = this.result();
      this.filter.set('');
      this.sort.set(null);
      this.picked.set(null);
      untracked(() => this.store.pickRow(null));
      const plain = (r?.columns ?? []).filter((c) => !c.geometry);
      const text = plain.find((c) => !this.isNumeric(c.type));
      const num = plain.find((c) => this.isNumeric(c.type));
      this.chartX.set(text?.name ?? plain[0]?.name ?? '');
      this.chartY.set(this.chartKind() === 'histogram' ? num?.name ?? COUNT : COUNT);
      this.styleCol.set(num?.name ?? text?.name ?? '');
      this.styleLabel.set('');
    });
    effect(() => {
      if (this.chartKind() === 'histogram' && this.chartY() === COUNT) this.chartY.set(this.numericColumns()[0]?.name ?? COUNT);
    });
  }

  setView(view: SqlView): void {
    const tab = this.store.active();
    if (tab) this.store.patch(tab.id, { view });
  }

  toggleSort(col: string): void {
    const s = this.sort();
    this.sort.set(!s || s.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null);
  }

  sortState(col: string): string | null {
    const s = this.sort();
    return s?.col === col ? (s.dir === 1 ? 'ascending' : 'descending') : null;
  }

  /** Row click: select it (table + map); clicking it again clears. */
  pick(i: number): void {
    const next = this.picked() === i ? null : i;
    this.picked.set(next);
    if (this.result()?.geometryColumn) this.store.pickRow(next);
  }

  clear(): void {
    const tab = this.store.active();
    if (tab) this.store.patch(tab.id, { result: null, plan: null, error: null, view: 'table' });
    this.store.mapStyle.set(null);
    this.store.clearMap();
  }

  applyStyle(): void {
    this.store.mapStyle.set({ column: this.styleCol(), label: this.styleLabel() || null });
    this.store.drawOnMap();
  }

  resetStyle(): void {
    this.store.mapStyle.set(null);
    this.store.drawOnMap();
  }

  openSave(): void {
    const tab = this.store.active();
    this.saveName = tab?.savedId ? tab.title : '';
    this.saveDesc = '';
    this.saveError.set(null);
    this.saveOpen.set(true);
  }

  save(): void {
    const name = this.saveName.trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.saveError.set(null);
    this.store.saveAsLayer(name, this.saveDesc).subscribe({
      next: (r) => {
        this.saving.set(false);
        this.saveOpen.set(false);
        this.notify.success(`Layer “${r.layer.name}” created with ${r.features.toLocaleString()} features.`);
      },
      error: (e: Error) => {
        this.saving.set(false);
        this.saveError.set(e.message);
      }
    });
  }

  export(format: 'csv' | 'xlsx' | 'geojson' | 'kml' | 'shapefile'): void {
    this.exporting.set(true);
    this.store.export(format).subscribe({
      next: () => this.exporting.set(false),
      error: (e: Error) => {
        this.exporting.set(false);
        this.notify.error(e.message);
      }
    });
  }

  // ----- copy & context menus -----

  private readonly ctxMenu = viewChild<ContextMenu>('ctxMenu');
  readonly ctxItems = signal<MenuItem[]>([]);

  private text(v: unknown): string {
    if (v === null || v === undefined) return '';
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }

  private plainCols(): SqlColumn[] {
    return (this.result()?.columns ?? []).filter((c) => !c.geometry);
  }

  private async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API needs a secure context; fall back to a hidden textarea.
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    this.notify.success(`${what} copied to the clipboard.`, 'Copied');
  }

  private tsvCell(v: unknown): string {
    return this.text(v).replace(/[\t\r\n]+/g, ' ');
  }

  copyRow(row: Record<string, unknown>): void {
    const cols = this.plainCols();
    void this.copy(cols.map((c) => this.tsvCell(row[c.name])).join('\t'), 'Row');
  }

  copyAll(): void {
    const cols = this.plainCols();
    const lines = [cols.map((c) => c.name).join('\t'), ...this.viewRows().map(({ row }) => cols.map((c) => this.tsvCell(row[c.name])).join('\t'))];
    void this.copy(lines.join('\n'), `${this.viewRows().length.toLocaleString()} rows`);
  }

  private wkt(geometry: unknown): string {
    const geom = new GeoJSON().readGeometry(geometry);
    return new WKT().writeGeometry(geom, { decimals: 7 });
  }

  /** "zone_name" = 'CENTRAL ZONE' — ready to paste into a WHERE. */
  private sqlCondition(col: SqlColumn, v: unknown): string {
    const name = /^[a-z_][a-z0-9_]*$/.test(col.name) ? col.name : `"${col.name.replace(/"/g, '""')}"`;
    if (v === null || v === undefined) return `${name} IS NULL`;
    if (typeof v === 'number' || typeof v === 'boolean') return `${name} = ${v}`;
    return `${name} = '${this.text(v).replace(/'/g, "''")}'`;
  }

  openCellMenu(event: MouseEvent, row: Record<string, unknown>, index: number, col: SqlColumn): void {
    event.preventDefault();
    const v = row[col.name];
    const r = this.result();
    const geom = r?.geometryColumn ? row[r.geometryColumn] : null;
    const items: MenuItem[] = [];
    if (!col.geometry) {
      items.push(
        { label: 'Copy value', icon: 'pi pi-clone', command: () => void this.copy(this.text(v), 'Value') },
        { label: 'Show only rows with this value', icon: 'pi pi-filter', disabled: v === null || v === undefined || typeof v === 'object',
          command: () => this.filter.set(this.text(v)) },
        { label: 'Copy as SQL condition', icon: 'pi pi-code', command: () => void this.copy(this.sqlCondition(col, v), 'Condition') },
        { separator: true }
      );
    }
    items.push(
      { label: 'Copy row', icon: 'pi pi-copy', command: () => this.copyRow(row) },
      { label: 'Copy row as JSON', icon: 'pi pi-code', command: () => {
          const obj: Record<string, unknown> = {};
          for (const c of this.plainCols()) obj[c.name] = row[c.name] ?? null;
          void this.copy(JSON.stringify(obj, null, 2), 'Row JSON');
        } }
    );
    if (geom) {
      items.push(
        { separator: true },
        { label: 'Zoom to feature', icon: 'pi pi-search-plus', command: () => this.store.zoomToResult(index) },
        { label: 'Select on map', icon: 'pi pi-map-marker', command: () => this.pick(index) },
        { label: 'Copy geometry as GeoJSON', icon: 'pi pi-map', command: () => void this.copy(JSON.stringify(geom), 'GeoJSON') },
        { label: 'Copy geometry as WKT', icon: 'pi pi-map', command: () => void this.copy(this.wkt(geom), 'WKT') }
      );
    }
    this.ctxItems.set(items);
    this.ctxMenu()?.show(event);
  }

  openHeaderMenu(event: MouseEvent, col: SqlColumn): void {
    event.preventDefault();
    const items: MenuItem[] = [
      { label: 'Sort ascending', icon: 'pi pi-sort-amount-up-alt', command: () => this.sort.set({ col: col.name, dir: 1 }) },
      { label: 'Sort descending', icon: 'pi pi-sort-amount-down', command: () => this.sort.set({ col: col.name, dir: -1 }) },
      { separator: true },
      { label: 'Copy column name', icon: 'pi pi-clone', command: () => void this.copy(col.name, 'Column name') }
    ];
    if (!col.geometry) {
      items.push(
        { label: 'Copy column values', icon: 'pi pi-list', command: () =>
            void this.copy(this.viewRows().map(({ row }) => this.tsvCell(row[col.name])).join('\n'), `${col.name} values`) },
        { label: 'Copy distinct values', icon: 'pi pi-list-check', command: () => {
            const vals = [...new Set(this.viewRows().map(({ row }) => this.tsvCell(row[col.name])))];
            void this.copy(vals.join('\n'), `${vals.length.toLocaleString()} distinct values`);
          } }
      );
    }
    this.ctxItems.set(items);
    this.ctxMenu()?.show(event);
  }

  isNumeric(type: string): boolean {
    return /^(smallint|integer|bigint|numeric|real|double precision)/.test(type);
  }

  shortType(c: SqlColumn): string {
    if (c.geometry) return 'geometry';
    return c.type
      .replace('character varying', 'text')
      .replace('double precision', 'float')
      .replace('timestamp without time zone', 'timestamp')
      .replace(/\(.*\)/, '');
  }

  cell(v: unknown, type = '', full = false): string {
    if (v === null || v === undefined) return full ? 'NULL' : '—';
    if (typeof v === 'number' && !full) {
      return Number.isInteger(v) && /int/.test(type) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 3 });
    }
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  geomLabel(v: unknown): string {
    return (v as { type?: string } | null)?.type ?? '—';
  }

  speed(cost: number): { label: string; cls: string } {
    return cost < 10_000 ? { label: 'Fast', cls: 'ok' } : cost < 1_000_000 ? { label: 'Moderate', cls: 'mid' } : { label: 'Slow', cls: 'bad' };
  }
}

function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 0 });
}
