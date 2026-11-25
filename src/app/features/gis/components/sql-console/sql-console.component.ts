import { DecimalPipe } from '@angular/common';
import { Component, DestroyRef, HostListener, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ButtonModule } from 'primeng/button';
import { DialogModule } from 'primeng/dialog';
import { TooltipModule } from 'primeng/tooltip';
import { format as formatSql } from 'sql-formatter';
import { NotificationService } from '../../../../core/services/notification.service';
import { SavedSqlQuery, SqlConsoleStore, SqlTable, paramNames } from './sql-console.store';
import { SqlEditorComponent } from './sql-editor.component';
import { SqlResultsComponent } from './sql-results.component';

type Library = 'layers' | 'saved' | 'examples' | 'history';

/** SQL Console panel: layer browser, query tabs, CodeMirror editor and
 *  (in workbench mode) the results, full screen. */
@Component({
  selector: 'app-sql-console',
  standalone: true,
  imports: [DecimalPipe, FormsModule, ButtonModule, DialogModule, TooltipModule, SqlEditorComponent, SqlResultsComponent],
  templateUrl: './sql-console.component.html',
  styleUrl: './sql-console.component.scss'
})
export class SqlConsoleComponent {
  readonly store = inject(SqlConsoleStore);
  private readonly notify = inject(NotificationService);
  private readonly editor = viewChild(SqlEditorComponent);

  readonly library = signal<Library>('layers');
  readonly layerQuery = signal('');
  readonly expanded = signal<string | null>(null);
  readonly libraries: { id: Library; label: string; icon: string }[] = [
    { id: 'layers', label: 'Layers', icon: 'pi pi-database' },
    { id: 'saved', label: 'Saved', icon: 'pi pi-star' },
    { id: 'examples', label: 'Examples', icon: 'pi pi-book' },
    { id: 'history', label: 'History', icon: 'pi pi-history' }
  ];

  readonly params = computed(() => paramNames(this.store.active()?.sql ?? ''));

  readonly filteredTables = computed(() => {
    const q = this.layerQuery().trim().toLowerCase();
    const all = this.store.tables();
    if (!q) return all;
    return all.filter(
      (t) => t.alias.includes(q) || t.name.toLowerCase().includes(q) || t.fields.some((f) => f.name.toLowerCase().includes(q))
    );
  });

  readonly mySaved = computed(() => this.store.saved().filter((q) => q.mine));
  readonly teamSaved = computed(() => this.store.saved().filter((q) => !q.mine));

  /** Ready-made queries built from the caller's own layers and fields. */
  readonly examples = computed(() => {
    const [a, b] = this.store.tables();
    if (!a) return [] as { label: string; hint: string; sql: string }[];
    const geom = (t: SqlTable) => t.fields.find((f) => f.type === 'geometry' || f.type === 'geography')?.name ?? 'geom';
    const label = (t: SqlTable) =>
      t.fields.find((f) => /^(name|.*_name|name_.*)$/i.test(f.name) && /char|text/.test(f.type))?.name ??
      t.fields.find((f) => /char|text/.test(f.type))?.name ?? t.fields[0]?.name ?? 'feat_id';
    const g = geom(a);
    const n = label(a);
    const km2 = `round((ST_Area(ST_Transform(${g}, 4326)::geography) / 1e6)::numeric, 2)`;
    const out = [
      { label: 'Count features', hint: a.alias, sql: `SELECT count(*) AS features\nFROM ${a.alias};` },
      { label: 'Group and count', hint: `${a.alias} by ${n}`, sql: `SELECT ${n}, count(*) AS features\nFROM ${a.alias}\nGROUP BY ${n}\nORDER BY features DESC;` },
      { label: 'Area in km²', hint: `each ${a.alias}`, sql: `SELECT ${n}, ${km2} AS area_km2, ${g}\nFROM ${a.alias}\nORDER BY area_km2 DESC;` },
      { label: '500 m buffer', hint: a.alias, sql: `SELECT ${n}, ST_Buffer(ST_Transform(${g}, 4326)::geography, 500) AS buffer\nFROM ${a.alias}\nLIMIT 50;` },
      { label: 'Centre points', hint: a.alias, sql: `SELECT ${n}, ST_PointOnSurface(${g}) AS geom\nFROM ${a.alias};` },
      { label: 'Search with a parameter', hint: `:search on ${n}`, sql: `SELECT *\nFROM ${a.alias}\nWHERE ${n}::text ILIKE '%' || :search || '%';` },
      { label: 'Rank by size', hint: 'window function', sql: `SELECT ${n},\n       ${km2} AS area_km2,\n       rank() OVER (ORDER BY ST_Area(${g}) DESC) AS size_rank\nFROM ${a.alias};` }
    ];
    if (b) {
      const bg = geom(b);
      out.push(
        {
          label: 'Spatial join — count inside',
          hint: `${b.alias} in each ${a.alias}`,
          sql: `SELECT a.${n}, count(b.*) AS ${b.alias}_count, a.${g}\nFROM ${a.alias} a\nLEFT JOIN ${b.alias} b ON ST_Intersects(a.${g}, b.${bg})\nGROUP BY a.${n}, a.${g}\nORDER BY ${b.alias}_count DESC;`
        },
        {
          label: 'Overlap area',
          hint: `${a.alias} ∩ ${b.alias}`,
          sql: `SELECT a.${n}, ST_Intersection(a.${g}, b.${bg}) AS geom\nFROM ${a.alias} a\nJOIN ${b.alias} b ON ST_Intersects(a.${g}, b.${bg})\nLIMIT 200;`
        }
      );
    }
    return out;
  });

  // save-query dialog
  readonly saveOpen = signal(false);
  readonly saving = signal(false);
  saveName = '';
  saveDesc = '';
  saveShared = false;

  constructor() {
    this.store.init();
    inject(DestroyRef).onDestroy(() => {
      this.store.workbench.set(false);
      this.store.clearMap();
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.store.workbench()) this.store.workbench.set(false);
  }

  showResults(): void {
    this.store.showResults.update((n) => n + 1);
  }

  // ----- editor -----

  onSqlChange(sql: string): void {
    this.store.setSql(sql);
  }

  insert(text: string): void {
    this.editor()?.insert(text);
  }

  use(sql: string, title?: string): void {
    const tab = this.store.active();
    // Keep the user's work: load into an empty tab, else open a new one.
    if (tab && !tab.sql.trim()) {
      this.store.patch(tab.id, { sql, error: null, ...(title ? { title } : {}) });
    } else {
      this.store.newTab(sql, title);
    }
    setTimeout(() => this.editor()?.focus());
  }

  format(): void {
    const tab = this.store.active();
    if (!tab?.sql.trim()) return;
    try {
      const pretty = formatSql(tab.sql, { language: 'postgresql', keywordCase: 'upper', tabWidth: 2, paramTypes: { named: [':'] } });
      this.store.patch(tab.id, { sql: pretty, error: null });
    } catch {
      this.notify.error('The query could not be formatted — check the syntax first.');
    }
  }

  setParam(name: string, value: string): void {
    const tab = this.store.active();
    if (tab) this.store.patch(tab.id, { params: { ...tab.params, [name]: value } });
  }

  renameTab(id: number, title: string): void {
    const t = title.trim();
    if (t) this.store.patch(id, { title: t.slice(0, 40) });
  }

  // ----- saved queries -----

  openSaveDialog(): void {
    const tab = this.store.active();
    if (!tab?.sql.trim()) return;
    const existing = tab.savedId ? this.store.saved().find((q) => q.id === tab.savedId && q.mine) : null;
    this.saveName = existing?.name ?? (tab.title.startsWith('Query ') ? '' : tab.title);
    this.saveDesc = existing?.description ?? '';
    this.saveShared = existing?.shared ?? false;
    this.saveOpen.set(true);
  }

  saveQuery(asNew = false): void {
    const tab = this.store.active();
    if (!tab || !this.saveName.trim() || this.saving()) return;
    const ownId = tab.savedId && this.store.saved().some((q) => q.id === tab.savedId && q.mine) ? tab.savedId : null;
    this.saving.set(true);
    this.store.saveQuery({ name: this.saveName.trim(), description: this.saveDesc, shared: this.saveShared }, asNew ? null : ownId).subscribe({
      next: (q) => {
        this.saving.set(false);
        this.saveOpen.set(false);
        this.notify.success(`Saved “${q.name}”${q.shared ? ' and shared with your team' : ''}.`);
      },
      error: (e: Error) => {
        this.saving.set(false);
        this.notify.error(e.message);
      }
    });
  }

  removeSaved(q: SavedSqlQuery, event: Event): void {
    event.stopPropagation();
    if (!confirm(`Delete the saved query “${q.name}”?`)) return;
    this.store.deleteSaved(q.id).subscribe({ error: (e: Error) => this.notify.error(e.message) });
  }

  // ----- helpers -----

  geomIcon(t: SqlTable): string {
    const g = (t.geometryType ?? '').toUpperCase();
    return g.includes('POINT') ? 'pi pi-map-marker' : g.includes('LINE') ? 'pi pi-wave-pulse' : g.includes('POLY') ? 'pi pi-stop' : 'pi pi-table';
  }

  geomClass(t: SqlTable): string {
    const g = (t.geometryType ?? '').toUpperCase();
    return g.includes('POINT') ? 'pt' : g.includes('LINE') ? 'ln' : g.includes('POLY') ? 'pg' : 'tb';
  }

  typeClass(type: string): string {
    if (type === 'geometry' || type === 'geography') return 'geo';
    if (/^(int|float|numeric|double|real|serial|bigint|smallint)/.test(type)) return 'num';
    if (/^(date|time|timestamp)/.test(type)) return 'date';
    if (type === 'bool') return 'bool';
    return 'text';
  }

  shortType(type: string): string {
    return type.replace(/^int\d$/, 'int').replace(/^float\d$/, 'float').replace('varchar', 'text').replace('timestamptz', 'timestamp');
  }

  oneLine(sql: string): string {
    const s = sql.replace(/\s+/g, ' ').trim();
    return s.length > 90 ? s.slice(0, 89) + '…' : s;
  }

  ago(iso: string): string {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 60) return 'just now';
    if (d < 3600) return `${Math.floor(d / 60)} min ago`;
    if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }
}
