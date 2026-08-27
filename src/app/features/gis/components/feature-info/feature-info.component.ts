import { Component, Input, OnChanges, SimpleChanges, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { FeatureInfoResult } from '../../services/map.service';

/** Internal/plumbing fields never shown to the user — not business data. */
const HIDDEN_ATTRIBUTE_KEYS = new Set(['gis_workspace_id']);

interface AttributeRow {
  key: string;
  value: string;
}

/**
 * Feature Information view (Task 6 §16/§17). Renders inline as the body of
 * the GIS workspace's "Identify" dock panel — including the "nothing here"
 * and multi-layer-result cases. Never a raw error/stack trace.
 */
@Component({
  selector: 'app-feature-info',
  standalone: true,
  imports: [ButtonModule, MessageModule],
  templateUrl: './feature-info.component.html',
  styleUrl: './feature-info.component.scss'
})
export class FeatureInfoComponent implements OnChanges {
  @Input() loading = false;
  @Input() error: string | null = null;
  @Input() results: FeatureInfoResult[] = [];

  readonly selectedIndex = signal(0);
  readonly showRawAttributes = signal(false);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['results']) {
      this.selectedIndex.set(0);
      this.showRawAttributes.set(false);
    }
  }

  get selectedResult(): FeatureInfoResult | null {
    return this.results[this.selectedIndex()] ?? null;
  }

  get selectedFeatureAttributes(): AttributeRow[] {
    const attributes = this.selectedResult?.features[0]?.attributes;
    if (!attributes) return [];
    return Object.entries(attributes)
      .filter(([key]) => !HIDDEN_ATTRIBUTE_KEYS.has(key))
      .map(([key, value]) => ({ key: this.humanizeKey(key), value: this.formatValue(value) }));
  }

  selectResult(index: number): void {
    this.selectedIndex.set(index);
    this.showRawAttributes.set(false);
  }

  toggleRaw(): void {
    this.showRawAttributes.update((current) => !current);
  }

  rawJson(): string {
    return JSON.stringify(this.selectedResult?.features[0]?.attributes ?? {}, null, 2);
  }

  private humanizeKey(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  private formatValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }
}
