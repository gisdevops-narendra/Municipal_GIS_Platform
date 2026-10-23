import { Component, Input, forwardRef, inject, signal } from '@angular/core';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { AutoCompleteCompleteEvent, AutoCompleteModule } from 'primeng/autocomplete';
import { CrsInfo, CrsService, crsLabel } from '../../services/crs.service';

interface CrsOption {
  label: string;
  crs: CrsInfo | null;
}

/**
 * Searchable CRS picker over every supported EPSG system — type a code
 * ("32643") or words of the name ("utm 43", "kalianpur"). The value is the
 * code ("EPSG:32643"), or '' for the optional `emptyLabel` choice (e.g.
 * "Auto-detect from the file", "Layer's own CRS"). Works with ngModel and
 * reactive forms.
 */
@Component({
  selector: 'app-crs-picker',
  standalone: true,
  imports: [FormsModule, AutoCompleteModule],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => CrsPickerComponent), multi: true }],
  template: `
    <p-autocomplete
      [ngModel]="selected()"
      (ngModelChange)="onModel($event)"
      [suggestions]="options()"
      (completeMethod)="search($event)"
      (onSelect)="pick($event.value)"
      (onClear)="pick(null)"
      optionLabel="label"
      [dropdown]="true"
      [completeOnFocus]="true"
      [forceSelection]="true"
      [showClear]="!!emptyLabel"
      [delay]="250"
      [placeholder]="emptyLabel || placeholder"
      [disabled]="disabled()"
      [inputId]="inputId"
      appendTo="body"
      scrollHeight="18rem"
      styleClass="crs-picker w-full"
      inputStyleClass="w-full"
      [fluid]="true"
      emptyMessage="No matching coordinate system"
    >
      <ng-template let-option #item>
        @if (option.crs; as crs) {
          <div class="crs-picker__item">
            <span class="crs-picker__code">{{ crs.code }}</span>
            <span class="crs-picker__name">{{ crs.name }}</span>
            <span class="crs-picker__unit">{{ crs.kind === 'geographic' ? 'degrees' : crs.unit }}</span>
          </div>
        } @else {
          <div class="crs-picker__item crs-picker__item--empty">{{ option.label }}</div>
        }
      </ng-template>
    </p-autocomplete>
  `,
  styles: [
    `
      .crs-picker__item { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; font-size: 0.85rem; }
      .crs-picker__code { font-family: var(--font-mono, monospace); font-weight: 600; white-space: nowrap; }
      .crs-picker__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .crs-picker__unit { opacity: 0.6; font-size: 0.75rem; white-space: nowrap; }
      .crs-picker__item--empty { font-style: italic; }
    `
  ]
})
export class CrsPickerComponent implements ControlValueAccessor {
  private readonly crsService = inject(CrsService);

  @Input() placeholder = 'Search EPSG code or name…';
  /** Optional "no CRS chosen" choice; its value is ''. */
  @Input() emptyLabel = '';
  @Input() inputId?: string;
  /** Shown first when nothing is typed (e.g. systems suited to a layer). */
  @Input() set suggested(list: CrsInfo[] | null | undefined) {
    this.suggestedList = list ?? [];
  }
  private suggestedList: CrsInfo[] = [];

  readonly selected = signal<CrsOption | null>(null);
  readonly options = signal<CrsOption[]>([]);
  readonly disabled = signal(false);
  private onChange: (value: string) => void = () => undefined;
  private onTouched: () => void = () => undefined;

  search(event: AutoCompleteCompleteEvent): void {
    // Focusing a filled picker searches for the shown label itself — that
    // matches nothing, so treat it as "show the list".
    const typed = (event.query ?? '').trim();
    const query = typed === this.selected()?.label || / · /.test(typed) ? '' : typed;
    this.crsService.search(query).subscribe({
      next: (list) => {
        const seen = new Set<string>();
        const first = query ? [] : this.suggestedList;
        const merged = [...first, ...list].filter((c) => !seen.has(c.code) && !!seen.add(c.code));
        this.options.set([
          ...(this.emptyLabel && !query ? [{ label: this.emptyLabel, crs: null }] : []),
          ...merged.map((crs) => ({ label: crsLabel(crs), crs }))
        ]);
      },
      error: () => this.options.set([])
    });
  }

  onModel(value: CrsOption | string | null): void {
    // forceSelection: free text is not a value; only picked options are.
    if (value === null || value === '') this.pick(null);
  }

  pick(option: CrsOption | null): void {
    this.selected.set(option?.crs ? option : null);
    this.onChange(option?.crs?.code ?? '');
    this.onTouched();
  }

  writeValue(code: string | null): void {
    if (!code) {
      this.selected.set(null);
      return;
    }
    this.selected.set({ label: code, crs: { code, srid: 0, name: code, kind: 'projected', unit: '', proj4: '' } });
    this.crsService.get(code).subscribe({
      next: (crs) => {
        if (crs && this.selected()?.crs?.code === crs.code) this.selected.set({ label: crsLabel(crs), crs });
      },
      error: () => undefined
    });
  }

  registerOnChange(fn: (value: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled.set(disabled);
  }
}
