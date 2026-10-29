import { Component, EventEmitter, Output, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { InputNumberModule } from 'primeng/inputnumber';
import { PasswordModule } from 'primeng/password';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { CheckboxModule } from 'primeng/checkbox';
import { TagModule } from 'primeng/tag';
import { ExternalDbService } from '../../../../core/services/external-db.service';
import {
  ExternalDataset,
  ExternalDbConnection,
  ExternalDbSelection,
  ExternalDbType,
  ExternalPreview
} from '../../../../core/models/external-db.model';
import { CrsPickerComponent } from '../crs-picker/crs-picker.component';

const CRS_PATTERN = /^EPSG:\d{4,6}$/;

const DB_TYPES: { value: ExternalDbType; label: string; port: number }[] = [
  { value: 'POSTGRESQL', label: 'PostgreSQL / PostGIS', port: 5432 },
  { value: 'MYSQL', label: 'MySQL / MariaDB', port: 3306 },
  { value: 'MONGODB', label: 'MongoDB', port: 27017 }
];

/**
 * Upload wizard, step 1 "From database": connect to the user's own
 * database, pick a table / collection, preview it and choose what to
 * import. Emits the import selection (or null while incomplete); the
 * wizard does the import itself, alongside the layer details.
 */
@Component({
  selector: 'app-upload-database',
  standalone: true,
  imports: [
    FormsModule,
    ButtonModule,
    InputTextModule,
    InputNumberModule,
    PasswordModule,
    SelectModule,
    MessageModule,
    CheckboxModule,
    TagModule,
    CrsPickerComponent
  ],
  templateUrl: './upload-database.component.html',
  styleUrl: './upload-database.component.scss'
})
export class UploadDatabaseComponent {
  /** The selection to import, or null until it is complete. */
  @Output() selectionChange = new EventEmitter<ExternalDbSelection | null>();
  /** A layer name suggested by the chosen table. */
  @Output() suggestName = new EventEmitter<string>();

  private readonly api = inject(ExternalDbService);

  readonly dbTypes = DB_TYPES;
  readonly sslModes = ['prefer', 'require', 'verify-ca', 'verify-full', 'disable'].map((v) => ({ label: v, value: v }));

  conn: ExternalDbConnection = { type: 'POSTGRESQL', host: '', port: 5432, database: '', username: '', password: '', sslMode: 'prefer' };

  readonly busy = signal<'test' | 'connect' | 'preview' | null>(null);
  readonly status = signal<{ severity: 'success' | 'error'; text: string } | null>(null);
  readonly datasets = signal<ExternalDataset[] | null>(null);
  readonly filter = signal('');
  readonly spatialOnly = signal(false);
  readonly selected = signal<ExternalDataset | null>(null);
  readonly preview = signal<ExternalPreview | null>(null);
  readonly previewError = signal<string | null>(null);

  // Import settings for the selected dataset.
  readonly fieldChoice = signal<Record<string, boolean>>({});
  readonly coordMode = signal<'GEOMETRY' | 'LATLON' | 'XY'>('GEOMETRY');
  readonly latField = signal('');
  readonly lonField = signal('');
  readonly xField = signal('');
  readonly yField = signal('');
  readonly sourceCrs = signal('');
  readonly limit = signal<number | null>(null);

  /** The connection the dataset list belongs to — editing the form after
   *  connecting must not silently import from somewhere else. */
  private connected: ExternalDbConnection | null = null;

  readonly visibleDatasets = computed(() => {
    const q = this.filter().trim().toLowerCase();
    return (this.datasets() ?? []).filter(
      (d) => (!this.spatialOnly() || d.geometryField) && (!q || d.name.toLowerCase().includes(q))
    );
  });

  readonly fieldNames = computed(() => (this.selected()?.fields ?? []).map((f) => f.name));
  readonly fieldOptions = computed(() => this.fieldNames().map((n) => ({ label: n, value: n })));

  readonly previewColumns = computed(() => {
    const p = this.preview();
    if (!p) return [];
    const cols = new Set<string>();
    if (p.dataset.geometryField) cols.add('__geometry');
    for (const f of p.dataset.fields) cols.add(f.name);
    for (const row of p.rows) Object.keys(row).forEach((k) => cols.add(k));
    return [...cols];
  });

  readonly selectedFieldCount = computed(() => Object.values(this.fieldChoice()).filter(Boolean).length);

  /** Why the selection can't be imported yet (null = ready). */
  readonly problem = computed<string | null>(() => {
    const d = this.selected();
    if (!d) return 'Choose a table or collection to import.';
    if (!this.preview()) return this.previewError() ?? 'Loading the preview…';
    const mode = this.coordMode();
    if (mode === 'GEOMETRY' && !d.geometryField) return 'This table has no geometry — choose its coordinate columns.';
    if (mode === 'LATLON' && (!this.latField() || !this.lonField())) return 'Choose the latitude and longitude columns.';
    if (mode === 'XY' && (!this.xField() || !this.yField())) return 'Choose the X and Y columns.';
    if (mode === 'XY' && !CRS_PATTERN.test(this.sourceCrs())) return 'Choose the CRS of the X / Y columns.';
    if (mode === 'GEOMETRY' && !d.crs && !CRS_PATTERN.test(this.sourceCrs())) {
      return "The table's CRS has no EPSG code — choose its source CRS.";
    }
    if (!this.selectedFieldCount() && d.fields.length) return 'Select at least one attribute field.';
    return null;
  });

  get isMongo(): boolean {
    return this.conn.type === 'MONGODB';
  }

  get isPostgres(): boolean {
    return this.conn.type === 'POSTGRESQL';
  }

  onTypeChange(type: ExternalDbType): void {
    const known = DB_TYPES.map((t) => t.port);
    if (!this.conn.port || known.includes(this.conn.port)) {
      this.conn.port = DB_TYPES.find((t) => t.value === type)!.port;
    }
    this.onConnectionEdited();
  }

  onConnectionEdited(): void {
    this.status.set(null);
  }

  private connectionProblem(): string | null {
    if (!this.conn.host.trim()) return 'Enter the host / server address.';
    if (!this.conn.port && !(this.isMongo && this.conn.srv)) return 'Enter the port.';
    if (!this.conn.database.trim()) return 'Enter the database name.';
    return null;
  }

  /** The connection as sent: only the fields that apply to its type. */
  private payload(): ExternalDbConnection {
    const c = this.conn;
    const base: ExternalDbConnection = {
      type: c.type,
      host: c.host.trim(),
      port: c.port || 27017,
      database: c.database.trim(),
      username: c.username?.trim() || undefined,
      password: c.password || undefined
    };
    if (c.type === 'POSTGRESQL') return { ...base, sslMode: c.sslMode, schemas: c.schemas?.trim() || undefined };
    if (c.type === 'MONGODB') return { ...base, authSource: c.authSource?.trim() || undefined, tls: !!c.tls, srv: !!c.srv };
    return base;
  }

  testConnection(): void {
    const problem = this.connectionProblem();
    if (problem) return this.status.set({ severity: 'error', text: problem });
    this.busy.set('test');
    this.status.set(null);
    this.api.test(this.payload()).subscribe({
      next: (r) => {
        this.busy.set(null);
        this.status.set({ severity: 'success', text: r.message });
      },
      error: (e: HttpErrorResponse) => this.fail(e)
    });
  }

  connect(): void {
    const problem = this.connectionProblem();
    if (problem) return this.status.set({ severity: 'error', text: problem });
    const connection = this.payload();
    this.busy.set('connect');
    this.status.set(null);
    this.clearSelection();
    this.api.datasets(connection).subscribe({
      next: (list) => {
        this.busy.set(null);
        this.connected = connection;
        this.datasets.set(list);
        const spatial = list.filter((d) => d.geometryField).length;
        this.spatialOnly.set(spatial > 0 && spatial < list.length);
        this.status.set({
          severity: 'success',
          text: list.length
            ? `Connected — ${list.length} tables / collections, ${spatial} with geometry.`
            : 'Connected, but the database has no tables or collections you can read.'
        });
      },
      error: (e: HttpErrorResponse) => {
        this.datasets.set(null);
        this.connected = null;
        this.fail(e);
      }
    });
  }

  disconnect(): void {
    this.connected = null;
    this.datasets.set(null);
    this.status.set(null);
    this.clearSelection();
  }

  get isConnected(): boolean {
    return !!this.connected;
  }

  select(dataset: ExternalDataset): void {
    if (!this.connected || this.selected()?.name === dataset.name) return;
    this.selected.set(dataset);
    this.preview.set(null);
    this.previewError.set(null);
    this.applyDefaults(dataset);
    this.suggestName.emit(this.nameFrom(dataset.table));
    this.emit();
    this.busy.set('preview');
    this.api.preview(this.connected, dataset.name).subscribe({
      next: (p) => {
        this.busy.set(null);
        if (this.selected()?.name !== dataset.name) return;
        // The preview describes the table more fully (e.g. MongoDB fields).
        this.selected.set(p.dataset);
        this.applyDefaults(p.dataset);
        this.preview.set(p);
        this.emit();
      },
      error: (e: HttpErrorResponse) => {
        this.busy.set(null);
        this.previewError.set(this.message(e));
        this.emit();
      }
    });
  }

  clearSelection(): void {
    this.selected.set(null);
    this.preview.set(null);
    this.previewError.set(null);
    this.emit();
  }

  private applyDefaults(d: ExternalDataset): void {
    this.fieldChoice.set(Object.fromEntries(d.fields.map((f) => [f.name, true])));
    const names = d.fields.map((f) => f.name);
    const find = (re: RegExp) => names.find((n) => re.test(n)) ?? '';
    this.latField.set(find(/^(lat|latitude|y_?lat)$/i));
    this.lonField.set(find(/^(lon|lng|long|longitude|x_?lon)$/i));
    this.xField.set(find(/^(x|easting|x_?coord)$/i));
    this.yField.set(find(/^(y|northing|y_?coord)$/i));
    this.sourceCrs.set('');
    this.limit.set(null);
    this.coordMode.set(d.geometryField ? 'GEOMETRY' : this.xField() && !this.latField() ? 'XY' : 'LATLON');
  }

  setCoordMode(mode: 'GEOMETRY' | 'LATLON' | 'XY'): void {
    this.coordMode.set(mode);
    this.emit();
  }

  toggleField(name: string, on: boolean): void {
    this.fieldChoice.update((m) => ({ ...m, [name]: on }));
    this.emit();
  }

  setAllFields(on: boolean): void {
    this.fieldChoice.update((m) => Object.fromEntries(Object.keys(m).map((k) => [k, on])));
    this.emit();
  }

  emit(): void {
    const d = this.selected();
    if (!d || !this.connected || this.problem()) {
      this.selectionChange.emit(null);
      return;
    }
    const mode = this.coordMode();
    const chosen = Object.entries(this.fieldChoice()).filter(([, on]) => on).map(([n]) => n);
    const allFields = chosen.length === d.fields.length;
    this.selectionChange.emit({
      connection: this.connected,
      dataset: d.name,
      geometryField: this.isMongo && mode === 'GEOMETRY' ? d.geometryField ?? undefined : undefined,
      fields: allFields ? undefined : chosen,
      limit: this.limit() || undefined,
      sourceCrs: CRS_PATTERN.test(this.sourceCrs()) && (mode === 'XY' || (mode === 'GEOMETRY' && !d.crs)) ? this.sourceCrs() : undefined,
      latitudeField: mode === 'LATLON' ? this.latField() : undefined,
      longitudeField: mode === 'LATLON' ? this.lonField() : undefined,
      xField: mode === 'XY' ? this.xField() : undefined,
      yField: mode === 'XY' ? this.yField() : undefined,
      points: mode !== 'GEOMETRY'
    });
  }

  cell(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }

  count(n: number | null): string {
    return n === null ? '—' : n.toLocaleString();
  }

  /** "public.ward_boundaries" → "Ward Boundaries". */
  private nameFrom(table: string): string {
    return table
      .replace(/[_\-.]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .slice(0, 150);
  }

  private fail(e: HttpErrorResponse): void {
    this.busy.set(null);
    this.status.set({ severity: 'error', text: this.message(e) });
  }

  private message(e: HttpErrorResponse): string {
    const m = e.error?.message;
    if (Array.isArray(m)) return m.join('. ');
    if (e.status === 0) return 'The server could not be reached.';
    return m ?? 'Something went wrong. Please try again.';
  }
}
