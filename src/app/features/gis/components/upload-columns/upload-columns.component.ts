import { Component, EventEmitter, Input, OnInit, Output, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { MessageModule } from 'primeng/message';
import { TagModule } from 'primeng/tag';
import { TooltipModule } from 'primeng/tooltip';
import { GisUploadsService } from '../../../../core/services/gis-uploads.service';
import {
  GisUpload,
  UploadColumnChange,
  UploadColumnKind,
  UploadSchema,
  UploadSchemaColumn,
} from '../../../../core/models/gis-upload.model';

/** One column being reviewed: the data as it is + what the user decides. */
interface ColumnRow {
  col: UploadSchemaColumn;
  newName: string;
  type: UploadColumnKind | 'other';
  removed: boolean;
}

interface TypeOption {
  label: string;
  value: UploadColumnKind | 'other';
  disabled: boolean;
}

const KIND_LABEL: Record<UploadColumnKind | 'other', string> = {
  text: 'Text',
  integer: 'Whole number',
  number: 'Decimal number',
  date: 'Date',
  boolean: 'Yes / No',
  other: 'Other',
};

const RESERVED = new Set([
  'ogc_fid', 'geom', 'gis_workspace_id', 'all', 'and', 'or', 'not', 'null', 'true', 'false', 'select', 'from',
  'where', 'group', 'order', 'by', 'limit', 'offset', 'table', 'column', 'user', 'like', 'in', 'is', 'between',
  'case', 'when', 'then', 'else', 'end', 'as', 'on', 'join', 'union', 'create', 'drop', 'alter', 'insert',
  'update', 'delete',
]);

/** "Prabhag No." -> "prabhag_no": lowercase, words joined by "_". */
export function toColumnName(text: string): string {
  const name = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(name) ? `c_${name}` : name;
}

/**
 * Upload wizard, step 3 "Columns": each imported column with example values.
 * The user renames columns and changes types (only conversions that keep
 * every value are offered — counted on the real data), then confirms the
 * list of changes. Nothing is changed without that confirmation.
 */
@Component({
  selector: 'app-upload-columns',
  standalone: true,
  imports: [FormsModule, ButtonModule, InputTextModule, SelectModule, MessageModule, TagModule, TooltipModule],
  templateUrl: './upload-columns.component.html',
  styleUrl: './upload-columns.component.scss',
})
export class UploadColumnsComponent implements OnInit {
  @Input({ required: true }) uploadId!: string;
  @Output() confirmed = new EventEmitter<GisUpload>();
  @Output() back = new EventEmitter<void>();

  private readonly uploads = inject(GisUploadsService);

  readonly schema = signal<UploadSchema | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly phase = signal<'edit' | 'review'>('edit');
  readonly applying = signal(false);
  readonly applyError = signal<string | null>(null);
  rows: ColumnRow[] = [];

  readonly kindLabel = KIND_LABEL;

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.uploads.schema(this.uploadId).subscribe({
      next: (schema) => {
        this.schema.set(schema);
        this.rows = schema.columns.map((col) => ({ col, newName: col.name, type: col.kind, removed: false }));
        this.loading.set(false);
      },
      error: (error: HttpErrorResponse) => {
        this.loading.set(false);
        this.loadError.set(this.message(error, 'Could not read the uploaded data.'));
      },
    });
  }

  // ---- editing -------------------------------------------------------------

  /** Types this column can become: its own, plus every conversion that
   *  keeps all values; ones that would lose values are shown disabled. */
  typeOptions(row: ColumnRow): TypeOption[] {
    const options: TypeOption[] = [{ label: KIND_LABEL[row.col.kind], value: row.col.kind, disabled: false }];
    for (const [kind, check] of Object.entries(row.col.conversions) as [UploadColumnKind, { failing: number }][]) {
      options.push({
        label: check.failing ? `${KIND_LABEL[kind]} (${check.failing} won't convert)` : KIND_LABEL[kind],
        value: kind,
        disabled: check.failing > 0,
      });
    }
    return options;
  }

  /** A few real values of the column, most common first. */
  examples(row: ColumnRow): string {
    return row.col.samples.slice(0, 3).map((s) => s.value).join(', ');
  }

  finalName(row: ColumnRow): string {
    return toColumnName(row.newName) || row.col.name;
  }

  /** Rows still in the data (not marked for removal). */
  keptRows(): ColumnRow[] {
    return this.rows.filter((r) => !r.removed);
  }

  toggleRemove(row: ColumnRow): void {
    row.removed = !row.removed;
  }

  /** Why the new name cannot be used (null = fine). */
  nameError(row: ColumnRow): string | null {
    if (row.removed) return null;
    const name = this.finalName(row);
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) return 'Use letters, digits and _ (max 63), starting with a letter.';
    if (RESERVED.has(name) && name !== row.col.name) return `"${name}" is reserved.`;
    if (this.rows.some((r) => r !== row && !r.removed && this.finalName(r) === name)) return `Another column is also called "${name}".`;
    return null;
  }

  hasErrors(): boolean {
    return this.rows.some((r) => this.nameError(r));
  }

  // ---- review & approve ----------------------------------------------------

  removals(): ColumnRow[] {
    return this.rows.filter((r) => r.removed);
  }

  renames(): ColumnRow[] {
    return this.keptRows().filter((r) => this.finalName(r) !== r.col.name);
  }

  retypes(): ColumnRow[] {
    return this.keptRows().filter((r) => r.type !== r.col.kind);
  }

  toReview(): void {
    if (this.hasErrors()) return;
    this.applyError.set(null);
    this.phase.set('review');
  }

  approve(): void {
    const columns: UploadColumnChange[] = this.rows.map((r) => {
      const change: UploadColumnChange = { name: r.col.name };
      if (r.removed) return { ...change, remove: true };
      if (this.finalName(r) !== r.col.name) change.newName = this.finalName(r);
      if (r.type !== r.col.kind && r.type !== 'other') change.type = r.type;
      return change;
    });
    this.applying.set(true);
    this.applyError.set(null);
    this.uploads.applySchema(this.uploadId, columns).subscribe({
      next: ({ upload }) => {
        this.applying.set(false);
        this.confirmed.emit(upload);
      },
      error: (error: HttpErrorResponse) => {
        this.applying.set(false);
        this.applyError.set(this.message(error, 'The changes could not be applied.'));
      },
    });
  }

  private message(error: HttpErrorResponse, fallback: string): string {
    const m = error.error?.message;
    return Array.isArray(m) ? m.join('. ') : (m ?? fallback);
  }
}
