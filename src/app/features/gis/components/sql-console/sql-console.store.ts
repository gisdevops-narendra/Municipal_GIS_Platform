import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, Subject, catchError, from, map, switchMap, tap, throwError } from 'rxjs';
import { environment } from '../../../../../environments/environment';
import { GisLayer } from '../../../../core/models/gis-layer.model';
import { AuthService } from '../../../../core/services/auth.service';
import { MapService } from '../../services/map.service';
import { userScopedKey } from '../../services/user-scoped-storage';

export interface SqlField {
  name: string;
  type: string;
}

export interface SqlTable {
  alias: string;
  layerId: string;
  name: string;
  geometryType: string | null;
  fields: SqlField[];
}

export interface SqlColumn {
  name: string;
  type: string;
  geometry: boolean;
}

export interface SqlResult {
  columns: SqlColumn[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  limit: number;
  geometryColumn: string | null;
  ms: number;
}

export interface SqlPlan {
  totalCost: number;
  estimatedRows: number;
  lines: { depth: number; label: string; rows: number; cost: number }[];
  hints: string[];
}

export interface SqlError {
  message: string;
  position?: number;
}

export type SqlView = 'table' | 'chart' | 'plan' | 'style';

export interface SqlTab {
  id: number;
  title: string;
  sql: string;
  params: Record<string, string>;
  running: boolean;
  result: SqlResult | null;
  error: SqlError | null;
  plan: SqlPlan | null;
  view: SqlView;
  /** Saved query this tab was opened from / saved as. */
  savedId: string | null;
}

export interface SavedSqlQuery {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  shared: boolean;
  updatedAt: string;
  mine: boolean;
}

export type SqlExportFormat = 'csv' | 'xlsx' | 'geojson' | 'kml' | 'shapefile';

const HISTORY_KEY = 'gis.sqlConsole.history';
const TABS_KEY = 'gis.sqlConsole.tabs';

/** :name placeholders outside strings, comments and ::casts. */
export function paramNames(sql: string): string[] {
  const out: string[] = [];
  const re = /'(?:[^']|'')*'?|"[^"]*"?|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|::|:([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** Shared state of the SQL Console: the editor panel, the results dock and
 *  the workbench all read and change this one store. Provided by the GIS
 *  workspace (it needs the workspace's MapService). */
@Injectable()
export class SqlConsoleStore {
  private readonly http = inject(HttpClient);
  private readonly mapService = inject(MapService);
  private readonly auth = inject(AuthService);
  private readonly baseUrl = `${environment.apiUrl}/gis/sql`;
  private nextId = 1;

  readonly tables = signal<SqlTable[]>([]);
  readonly tablesError = signal<string | null>(null);
  readonly tablesLoading = signal(false);
  readonly tabs = signal<SqlTab[]>([]);
  readonly activeId = signal(0);
  readonly active = computed(() => this.tabs().find((t) => t.id === this.activeId()) ?? this.tabs()[0] ?? null);
  readonly limit = signal(1000);
  readonly workbench = signal(false);
  readonly saved = signal<SavedSqlQuery[]>([]);
  readonly history = signal<string[]>([]);
  /** Bumped when results should appear in the bottom dock. */
  readonly showResults = signal(0);
  /** A layer made with "Save as layer" (the workspace reloads its list). */
  readonly layerCreated = new Subject<GisLayer>();
  /** Map styling of the active result (null = plain highlight). */
  readonly mapStyle = signal<{ column: string; label: string | null } | null>(null);

  private storageKey(base: string): string {
    return userScopedKey(base, 'all', this.auth.user()?.id);
  }

  /** Loads layers, saved queries, history and the user's open tabs. */
  init(): void {
    if (!this.tabs().length) this.restoreTabs();
    this.history.set(this.read<string[]>(HISTORY_KEY, []).filter((x) => typeof x === 'string').slice(0, 20));
    this.loadTables();
    this.loadSaved();
  }

  loadTables(): void {
    this.tablesLoading.set(true);
    this.http.get<SqlTable[]>(`${this.baseUrl}/tables`).subscribe({
      next: (t) => {
        this.tablesLoading.set(false);
        this.tablesError.set(null);
        this.tables.set(t);
        const tab = this.active();
        if (tab && !tab.sql && t[0]) this.patch(tab.id, { sql: `SELECT *\nFROM ${t[0].alias}\nLIMIT 100` });
      },
      error: (e: HttpErrorResponse) => {
        this.tablesLoading.set(false);
        this.tablesError.set(this.message(e, 'Could not load the layer list.').message);
      }
    });
  }

  // ----- tabs -----

  newTab(sql = '', title?: string, savedId: string | null = null): void {
    const id = this.nextId++;
    const tab: SqlTab = {
      id,
      title: title ?? `Query ${id}`,
      sql,
      params: {},
      running: false,
      result: null,
      error: null,
      plan: null,
      view: 'table',
      savedId
    };
    this.tabs.update((t) => [...t, tab]);
    this.select(id);
    this.persistTabs();
  }

  closeTab(id: number): void {
    const list = this.tabs();
    const i = list.findIndex((t) => t.id === id);
    if (i < 0) return;
    const next = list.filter((t) => t.id !== id);
    this.tabs.set(next);
    if (!next.length) this.newTab();
    else if (this.activeId() === id) this.select(next[Math.max(0, i - 1)].id);
    this.persistTabs();
  }

  select(id: number): void {
    this.activeId.set(id);
    this.mapStyle.set(null);
    this.drawOnMap();
  }

  patch(id: number, changes: Partial<SqlTab>): void {
    this.tabs.update((list) => list.map((t) => (t.id === id ? { ...t, ...changes } : t)));
    if ('sql' in changes || 'title' in changes || 'params' in changes) this.persistTabs();
  }

  setSql(sql: string): void {
    const tab = this.active();
    if (tab) this.patch(tab.id, { sql, error: null });
  }

  // ----- run / explain -----

  run(): void {
    const tab = this.active();
    if (!tab || tab.running || !tab.sql.trim()) return;
    const sql = tab.sql;
    this.patch(tab.id, { running: true, error: null });
    this.http
      .post<SqlResult>(`${this.baseUrl}/run`, { sql, limit: this.limit(), params: this.paramsFor(tab) })
      .subscribe({
        next: (result) => {
          this.patch(tab.id, { running: false, result, plan: null, view: tab.view === 'plan' ? 'table' : tab.view });
          this.remember(sql);
          this.mapStyle.set(null);
          if (this.activeId() === tab.id) this.drawOnMap();
          this.showResults.update((n) => n + 1);
        },
        error: (e: HttpErrorResponse) => this.patch(tab.id, { running: false, error: this.message(e, 'The query failed.', sql) })
      });
  }

  explain(): void {
    const tab = this.active();
    if (!tab || tab.running || !tab.sql.trim()) return;
    this.patch(tab.id, { running: true, error: null });
    this.http.post<SqlPlan>(`${this.baseUrl}/explain`, { sql: tab.sql, params: this.paramsFor(tab) }).subscribe({
      next: (plan) => {
        this.patch(tab.id, { running: false, plan, view: 'plan' });
        this.showResults.update((n) => n + 1);
      },
      error: (e: HttpErrorResponse) => this.patch(tab.id, { running: false, error: this.message(e, 'Could not explain the query.', tab.sql) })
    });
  }

  private paramsFor(tab: SqlTab): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of paramNames(tab.sql)) out[name] = tab.params[name] ?? '';
    return out;
  }

  // ----- results → map -----

  /** Plain highlight of the active result, or the "Style map" colouring. */
  drawOnMap(): void {
    const r = this.active()?.result;
    this.mapService.clearStyledResult();
    this.mapService.setSqlPicked(null);
    if (!r?.geometryColumn) {
      this.mapService.clearQueryHighlight();
      return;
    }
    const geoms = r.rows.map((row) => row[r.geometryColumn!] as Record<string, unknown> | null);
    const style = this.mapStyle();
    if (!style) {
      this.mapService.setQueryHighlight(geoms);
      return;
    }
    this.mapService.clearQueryHighlight();
    const colorOf = colorScale(r.rows.map((row) => row[style.column]));
    this.mapService.setStyledResult(
      r.rows.map((row, i) => ({
        geometry: geoms[i],
        color: colorOf(row[style.column]),
        label: style.label ? formatLabel(row[style.label]) : undefined
      }))
    );
  }

  clearMap(): void {
    this.mapService.clearQueryHighlight();
    this.mapService.clearStyledResult();
    this.mapService.setSqlPicked(null);
  }

  /** Marks one result row on the map (null clears) and zooms to it. */
  pickRow(index: number | null): void {
    const r = this.active()?.result;
    const geom = index !== null && r?.geometryColumn ? (r.rows[index]?.[r.geometryColumn] as Record<string, unknown> | null) : null;
    this.mapService.setSqlPicked(geom ?? null);
    if (geom) this.mapService.zoomToGeometries([geom]);
  }

  zoomToResult(index?: number): void {
    const r = this.active()?.result;
    if (!r?.geometryColumn) return;
    const rows = index === undefined ? r.rows : [r.rows[index]];
    this.mapService.zoomToGeometries(rows.map((row) => row?.[r.geometryColumn!] as Record<string, unknown> | null));
  }

  // ----- save as layer / export -----

  saveAsLayer(name: string, description: string): Observable<{ layer: GisLayer; features: number }> {
    const tab = this.active()!;
    return this.http
      .post<{ layer: GisLayer; features: number }>(`${this.baseUrl}/save-layer`, { sql: tab.sql, params: this.paramsFor(tab), name, description })
      .pipe(
        tap((r) => this.layerCreated.next(r.layer)),
        catchError((e: HttpErrorResponse) => this.rethrow(e, 'Could not save the layer.'))
      );
  }

  export(format: SqlExportFormat): Observable<void> {
    const tab = this.active()!;
    return this.http
      .post(`${this.baseUrl}/export`, { sql: tab.sql, params: this.paramsFor(tab), format }, { responseType: 'blob', observe: 'response' })
      .pipe(
        map((res) => {
          const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `query-result.${format}`;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(res.body!);
          a.download = name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        }),
        catchError((e: HttpErrorResponse) =>
          // Error bodies arrive as a Blob because of responseType.
          e.error instanceof Blob
            ? from(e.error.text()).pipe(
                switchMap((text) => {
                  let message = 'The export failed.';
                  try {
                    message = (JSON.parse(text) as { message?: string }).message ?? message;
                  } catch {
                    /* not JSON */
                  }
                  return throwError(() => new Error(message));
                })
              )
            : this.rethrow(e, 'The export failed.')
        )
      );
  }

  // ----- saved queries -----

  loadSaved(): void {
    this.http.get<SavedSqlQuery[]>(`${this.baseUrl}/saved`).subscribe({ next: (s) => this.saved.set(s), error: () => undefined });
  }

  saveQuery(body: { name: string; description: string; shared: boolean }, id: string | null): Observable<SavedSqlQuery> {
    const tab = this.active()!;
    const payload = { ...body, sql: tab.sql };
    const req = id
      ? this.http.put<SavedSqlQuery>(`${this.baseUrl}/saved/${id}`, payload)
      : this.http.post<SavedSqlQuery>(`${this.baseUrl}/saved`, payload);
    return req.pipe(
      tap((q) => {
        this.patch(tab.id, { savedId: q.id, title: q.name });
        this.loadSaved();
      }),
      catchError((e: HttpErrorResponse) => this.rethrow(e, 'Could not save the query.'))
    );
  }

  deleteSaved(id: string): Observable<unknown> {
    return this.http.delete(`${this.baseUrl}/saved/${id}`).pipe(
      tap(() => {
        this.saved.update((s) => s.filter((q) => q.id !== id));
        for (const t of this.tabs()) if (t.savedId === id) this.patch(t.id, { savedId: null });
      }),
      catchError((e: HttpErrorResponse) => this.rethrow(e, 'Could not delete the query.'))
    );
  }

  openSaved(q: SavedSqlQuery): void {
    const open = this.tabs().find((t) => t.savedId === q.id);
    if (open) this.select(open.id);
    else this.newTab(q.sql, q.name, q.id);
  }

  // ----- history / persistence -----

  private remember(sql: string): void {
    const next = [sql, ...this.history().filter((h) => h !== sql)].slice(0, 20);
    this.history.set(next);
    this.write(HISTORY_KEY, next);
  }

  private persistTabs(): void {
    this.write(TABS_KEY, {
      active: this.activeId(),
      tabs: this.tabs().map((t) => ({ title: t.title, sql: t.sql, params: t.params, savedId: t.savedId }))
    });
  }

  private restoreTabs(): void {
    const saved = this.read<{ active?: number; tabs?: { title: string; sql: string; params?: Record<string, string>; savedId?: string | null }[] }>(TABS_KEY, {});
    const list = (saved.tabs ?? []).slice(0, 12);
    if (!list.length) {
      this.newTab();
      return;
    }
    for (const t of list) this.newTab(t.sql ?? '', t.title, t.savedId ?? null);
    this.tabs.update((tabs) => tabs.map((t, i) => ({ ...t, params: list[i].params ?? {} })));
    this.select(this.tabs()[0].id);
  }

  private read<T>(base: string, fallback: T): T {
    try {
      const v = localStorage.getItem(this.storageKey(base));
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  private write(base: string, value: unknown): void {
    try {
      localStorage.setItem(this.storageKey(base), JSON.stringify(value));
    } catch {
      /* storage full / disabled */
    }
  }

  private rethrow(e: HttpErrorResponse, fallback: string) {
    return throwError(() => new Error(this.message(e, fallback).message));
  }

  /** Server message, plus where in the text the problem is when known. */
  message(e: HttpErrorResponse, fallback: string, sql?: string): SqlError {
    const body = e.error as { message?: string | string[]; position?: number } | null;
    const message = (Array.isArray(body?.message) ? body!.message.join(' ') : body?.message) || fallback;
    let position = typeof body?.position === 'number' ? body.position : undefined;
    if (position === undefined && sql) {
      // "column "x" does not exist" → point at x in the editor.
      const name = /(?:column|relation|function|table) "?([^"\s(]+)"?/i.exec(message)?.[1];
      if (name) {
        const i = sql.toLowerCase().indexOf(name.toLowerCase().replace(/^.*\./, ''));
        if (i >= 0) position = i;
      }
    }
    return { message, position };
  }
}

const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#a16207'];
const RAMP = ['#fff5eb', '#fdd0a2', '#fd8d3c', '#e6550d', '#a63603'];

/** Numbers → 5-class quantile ramp; anything else → categorical palette. */
export function colorScale(values: unknown[]): (v: unknown) => string {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (nums.length && nums.length >= values.filter((v) => v !== null && v !== undefined).length) {
    const sorted = [...nums].sort((a, b) => a - b);
    const breaks = [1, 2, 3, 4].map((k) => sorted[Math.floor((k / 5) * (sorted.length - 1))]);
    return (v) => (typeof v === 'number' ? RAMP[breaks.filter((b) => v > b).length] : '#9ca3af');
  }
  const keys = [...new Set(values.map((v) => String(v ?? '')))];
  return (v) => PALETTE[keys.indexOf(String(v ?? '')) % PALETTE.length];
}

export function legendFor(values: unknown[]): { color: string; label: string }[] {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const colorOf = colorScale(values);
  if (nums.length && nums.length >= values.filter((v) => v !== null && v !== undefined).length) {
    const sorted = [...nums].sort((a, b) => a - b);
    const edges = [0, 1, 2, 3, 4, 5].map((k) => sorted[Math.floor((k / 5) * (sorted.length - 1))]);
    return RAMP.map((color, i) => ({ color, label: `${fmt(edges[i])} – ${fmt(edges[i + 1])}` }));
  }
  const keys = [...new Set(values.map((v) => String(v ?? '')))].slice(0, 12);
  return keys.map((k) => ({ color: colorOf(k), label: k || '(empty)' }));
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatLabel(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return typeof v === 'number' ? fmt(v) : String(v);
}
