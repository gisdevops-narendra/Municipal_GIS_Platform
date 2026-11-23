import { Component, Input, OnChanges, SimpleChanges, inject, signal } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { FeatureInfoResult, MapService } from '../../services/map.service';
import { copyText } from '../../../../shared/copy-text';

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
  /** Which feature of the selected layer is shown — a click on overlapping
   *  polygons or stacked points returns several, not just one. */
  readonly featureIndex = signal(0);
  readonly showRawAttributes = signal(false);
  private readonly mapService = inject(MapService);
  /** Short "Copied" feedback: the copied row key, or '*' for all. */
  readonly copied = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  get hasGeometry(): boolean {
    return !!this.selectedResult?.features[this.featureIndex()]?.geometry;
  }

  zoomToFeature(): void {
    const geometry = this.selectedResult?.features[this.featureIndex()]?.geometry;
    if (geometry) this.mapService.zoomToGeometries([geometry]);
  }

  /** Copies one value, or (no row) every attribute as "Field: value" lines. */
  copy(row?: AttributeRow): void {
    const text = row ? row.value : this.selectedFeatureAttributes.map((r) => `${r.key}: ${r.value}`).join('\n');
    void copyText(text).then((ok) => {
      if (!ok) return;
      this.copied.set(row ? row.key : '*');
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(null), 1500);
    });
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['results']) {
      this.selectedIndex.set(0);
      this.featureIndex.set(0);
      this.showRawAttributes.set(false);
    }
  }

  get selectedResult(): FeatureInfoResult | null {
    return this.results[this.selectedIndex()] ?? null;
  }

  get featureCount(): number {
    return this.selectedResult?.features.length ?? 0;
  }

  stepFeature(delta: number): void {
    const count = this.featureCount;
    if (count > 1) this.featureIndex.set((this.featureIndex() + delta + count) % count);
  }

  get selectedFeatureAttributes(): AttributeRow[] {
    const attributes = this.selectedResult?.features[this.featureIndex()]?.attributes;
    if (!attributes) return [];
    return Object.entries(attributes)
      .filter(([key]) => !HIDDEN_ATTRIBUTE_KEYS.has(key))
      .map(([key, value]) => ({ key: this.humanizeKey(key), value: this.formatValue(value) }));
  }

  selectResult(index: number): void {
    this.selectedIndex.set(index);
    this.featureIndex.set(0);
    this.showRawAttributes.set(false);
  }

  toggleRaw(): void {
    this.showRawAttributes.update((current) => !current);
  }

  rawJson(): string {
    return JSON.stringify(this.selectedResult?.features[this.featureIndex()]?.attributes ?? {}, null, 2);
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
