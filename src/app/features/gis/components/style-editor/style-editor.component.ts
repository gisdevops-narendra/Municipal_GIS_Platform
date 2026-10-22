import {
  Component,
  EventEmitter,
  Input,
  OnDestroy,
  OnInit,
  Output,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { Subject, debounceTime } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ButtonModule } from 'primeng/button';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { InputNumberModule } from 'primeng/inputnumber';
import { InputTextModule } from 'primeng/inputtext';
import { ColorPickerModule } from 'primeng/colorpicker';
import { SliderModule } from 'primeng/slider';
import { MessageModule } from 'primeng/message';
import {
  BuiltinIcon,
  CLASSIFICATION_METHODS,
  COLOR_RAMPS,
  ClassificationMethod,
  DASH_PRESETS,
  FONT_FAMILIES,
  IconRef,
  LayerStyleSpec,
  MARK_SHAPES,
  StyleAttribute,
  StyleCategory,
  StyleGeometry,
  StyleMode,
  StyleTargetRef,
  SymbolSpec,
  defaultSpec,
  sampleRamp,
} from '../../../../core/models/layer-style.model';
import { LayerStyleService } from '../../../../core/services/layer-style.service';
import { NotificationService } from '../../../../core/services/notification.service';

/** Public icon search + SVG API (CORS-enabled), covering Google's and
 *  Font Awesome's free icon sets among others. */
const ICONIFY_API = 'https://api.iconify.design';

/** Free icon libraries offered for point markers. Each was tested end to
 *  end: search, SVG download in a chosen colour, the backend's SVG
 *  sanitiser, and rendering by GeoServer on the map. All allow commercial
 *  use; flag sets are left out (their icons are named by country code, so
 *  they cannot be found by search). */
interface OnlineIconLibrary {
  label: string;
  /** Iconify collection prefix(es), comma-separated. */
  value: string;
  license: string;
  /** Icons keep their own colours (the colour choice does not apply). */
  multicolor?: boolean;
}

const ONLINE_ICON_GROUPS: { label: string; items: OnlineIconLibrary[] }[] = [
  {
    label: 'Google',
    items: [
      { label: 'Material Symbols', value: 'material-symbols', license: 'Apache 2.0' },
      { label: 'Material Icons', value: 'ic', license: 'Apache 2.0' },
    ],
  },
  {
    label: 'Font Awesome Free',
    items: [
      { label: 'Font Awesome Solid', value: 'fa7-solid', license: 'CC BY 4.0' },
      { label: 'Font Awesome Regular', value: 'fa7-regular', license: 'CC BY 4.0' },
      { label: 'Font Awesome Brands', value: 'fa7-brands', license: 'CC BY 4.0' },
    ],
  },
  {
    label: 'Maps & places',
    items: [
      { label: 'Maki (Mapbox)', value: 'maki', license: 'CC0' },
      { label: 'Temaki', value: 'temaki', license: 'CC0' },
      { label: 'Map Icons', value: 'map', license: 'OFL 1.1' },
      { label: 'Health Icons', value: 'healthicons', license: 'MIT' },
    ],
  },
  {
    label: 'General',
    items: [
      { label: 'Material Design Icons', value: 'mdi', license: 'Apache 2.0' },
      { label: 'Tabler', value: 'tabler', license: 'MIT' },
      { label: 'Lucide', value: 'lucide', license: 'ISC' },
      { label: 'Phosphor', value: 'ph', license: 'MIT' },
      { label: 'Bootstrap Icons', value: 'bi', license: 'MIT' },
      { label: 'Remix Icon', value: 'ri', license: 'Apache 2.0' },
      { label: 'Heroicons', value: 'heroicons', license: 'MIT' },
      { label: 'Ionicons', value: 'ion', license: 'MIT' },
      { label: 'Carbon (IBM)', value: 'carbon', license: 'Apache 2.0' },
      { label: 'Fluent UI (Microsoft)', value: 'fluent', license: 'MIT' },
      { label: 'Iconoir', value: 'iconoir', license: 'MIT' },
      { label: 'MingCute', value: 'mingcute', license: 'Apache 2.0' },
    ],
  },
  {
    label: 'Colour emoji',
    items: [
      { label: 'Noto Emoji (Google)', value: 'noto', license: 'Apache 2.0', multicolor: true },
      { label: 'Twemoji', value: 'twemoji', license: 'CC BY 4.0', multicolor: true },
    ],
  },
];

const ONLINE_ICON_LIBRARIES = ONLINE_ICON_GROUPS.flatMap((g) => g.items);

/** Picker options: every library at once first, then the groups. */
const ONLINE_ICON_SOURCES: { label: string; items: OnlineIconLibrary[] }[] = [
  {
    label: 'All',
    items: [
      {
        label: `All libraries (${ONLINE_ICON_LIBRARIES.length})`,
        value: ONLINE_ICON_LIBRARIES.map((l) => l.value).join(','),
        license: 'see each icon',
      },
    ],
  },
  ...ONLINE_ICON_GROUPS,
];

const ZOOM_TO_DENOM = (z: number): number => 559082264.028 / Math.pow(2, z);

/**
 * Reusable GIS layer styling editor — used from the upload wizard's
 * Preview step (`target.kind === 'upload'`) and the map layer panel /
 * `/gis/layers` (`target.kind === 'layer'`). Builds a `LayerStyleSpec`;
 * the backend turns it into YSLD, GeoServer stores it, and the existing
 * WMS layer re-renders. No second map, no client-side vector styling.
 */
@Component({
  selector: 'app-style-editor',
  standalone: true,
  imports: [
    DecimalPipe,
    FormsModule,
    ButtonModule,
    SelectModule,
    CheckboxModule,
    InputNumberModule,
    InputTextModule,
    ColorPickerModule,
    SliderModule,
    MessageModule,
  ],
  templateUrl: './style-editor.component.html',
  styleUrl: './style-editor.component.scss',
})
export class StyleEditorComponent implements OnInit, OnDestroy {
  private readonly styleService = inject(LayerStyleService);
  private readonly notify = inject(NotificationService);

  @Input({ required: true }) target!: StyleTargetRef;
  @Input({ required: true }) geometry!: StyleGeometry;
  @Input() layerName = '';
  /** Map context — debounce-apply on every change so the map tracks edits. */
  @Input() live = false;

  @Output() applied = new EventEmitter<{ styleName?: string }>();
  @Output() removed = new EventEmitter<void>();
  @Output() closed = new EventEmitter<void>();

  readonly markShapes = MARK_SHAPES;
  readonly fonts = FONT_FAMILIES;
  readonly methods = CLASSIFICATION_METHODS;
  readonly dashPresets = DASH_PRESETS;
  readonly ramps = COLOR_RAMPS;

  readonly spec = signal<LayerStyleSpec>(defaultSpec('polygon'));
  readonly attributes = signal<StyleAttribute[]>([]);
  readonly state = signal<'loading' | 'idle' | 'applying' | 'error'>('loading');
  readonly errorMsg = signal<string | null>(null);
  readonly classifying = signal(false);
  readonly hasSavedStyle = signal(false);
  readonly rampId = signal('viridis');

  /** ExternalGraphic icon picker (point geometry only). */
  readonly builtinIcons = signal<BuiltinIcon[]>([]);
  readonly iconGalleryOpen = signal(false);
  readonly iconUploading = signal(false);
  readonly iconError = signal<string | null>(null);
  readonly maxIconBytes = 512 * 1024;
  /** Icon picker tab: the bundled gallery, or an online icon search. */
  readonly iconTab = signal<'builtin' | 'online'>('builtin');
  readonly onlineSources = ONLINE_ICON_SOURCES;
  readonly onlineSource = signal(ONLINE_ICON_SOURCES[0].items[0].value);
  /** The selected library (null for "All libraries"). */
  readonly onlineLibrary = computed(() => ONLINE_ICON_LIBRARIES.find((l) => l.value === this.onlineSource()) ?? null);
  readonly onlineQuery = signal('');
  readonly onlineResults = signal<string[]>([]);
  readonly onlineLoading = signal(false);
  readonly onlineError = signal<string | null>(null);
  /** Colour the online icon is downloaded in (it is stored as-is). */
  readonly onlineColor = signal('#c62828');
  /** "prefix:name" being downloaded + uploaded. */
  readonly onlinePicking = signal<string | null>(null);
  private readonly onlineSearch$ = new Subject<void>();
  private readonly onlineSearchSub = this.onlineSearch$
    .pipe(debounceTime(300), takeUntilDestroyed())
    .subscribe(() => this.runOnlineSearch());

  /** Object URL for the currently selected custom icon (upload / reload). */
  private customIconObjectUrl: string | null = null;
  readonly customIconPreview = signal<string | null>(null);

  readonly modes = computed<{ label: string; value: StyleMode }[]>(() => {
    const base: { label: string; value: StyleMode }[] = [
      { label: 'Single symbol', value: 'single' },
    ];
    if (this.geometry !== 'raster') {
      base.push(
        { label: 'Categorized', value: 'categorized' },
        { label: 'Graduated', value: 'graduated' },
      );
    }
    return base;
  });

  readonly categoricalFields = computed(() =>
    this.attributes()
      .filter((a) => a.kind === 'string' || a.kind === 'boolean' || a.kind === 'number' || a.kind === 'other')
      .map((a) => ({ label: a.name, value: a.name })),
  );
  readonly numericFields = computed(() =>
    this.attributes()
      .filter((a) => a.kind === 'number')
      .map((a) => ({ label: a.name, value: a.name })),
  );
  readonly labelFields = computed(() =>
    this.attributes()
      .filter((a) => a.kind !== 'geometry')
      .map((a) => ({ label: a.name, value: a.name })),
  );

  private readonly change$ = new Subject<void>();
  private pendingLiveApply = false;

  constructor() {
    this.change$
      .pipe(debounceTime(550), takeUntilDestroyed())
      .subscribe(() => {
        if (!this.live) return;
        if (this.state() === 'applying') {
          // Applied as soon as the current request finishes — dropping it
          // left the map showing an older style than the editor.
          this.pendingLiveApply = true;
        } else {
          this.apply(true);
        }
      });
  }

  ngOnInit(): void {
    this.spec.set(defaultSpec(this.geometry));
    if (this.geometry === 'point') {
      this.styleService.builtinIcons().subscribe({
        next: (response) => this.builtinIcons.set(response.icons),
        error: () => this.builtinIcons.set([]),
      });
    }
    this.styleService.attributes(this.target).subscribe({
      next: (response) => {
        this.attributes.set(response.attributes);
        if (this.target.kind === 'layer') {
          this.loadExistingStyle();
        } else {
          this.state.set('idle');
        }
      },
      error: (error: HttpErrorResponse) => this.fail(this.msg(error)),
    });
  }

  private loadExistingStyle(): void {
    this.styleService.getStyle(this.target).subscribe({
      next: (stored) => {
        if (stored.spec) {
          this.spec.set(stored.spec);
          this.hasSavedStyle.set(true);
          const icon = stored.spec.symbol?.icon;
          if (icon?.source === 'custom') this.loadCustomIconPreview(icon.name);
        }
        this.state.set('idle');
      },
      error: () => this.state.set('idle'),
    });
  }

  // ---- editing --------------------------------------------------

  get s(): LayerStyleSpec {
    return this.spec();
  }

  setMode(mode: StyleMode): void {
    this.spec.update((spec) => ({ ...spec, mode }));
    this.touch();
  }

  patchSymbol(patch: Partial<SymbolSpec>): void {
    this.spec.update((spec) => ({
      ...spec,
      symbol: { ...spec.symbol, ...this.normalize(patch) },
    }));
    this.touch();
  }

  // ---- point icon (ExternalGraphic) ---------------------------

  /** True when the point renders as an icon rather than a vector mark. */
  get usesIcon(): boolean {
    return !!this.spec().symbol.icon;
  }

  /** `<img>` src for the currently selected icon (gallery thumb or upload). */
  iconPreviewUrl(): string | null {
    const icon = this.spec().symbol.icon;
    if (!icon) return null;
    return icon.source === 'builtin'
      ? this.styleService.builtinIconUrl(icon.name)
      : this.customIconPreview();
  }

  builtinIconUrl(id: string): string {
    return this.styleService.builtinIconUrl(id);
  }

  toggleIconGallery(): void {
    this.iconGalleryOpen.update((open) => !open);
  }

  selectBuiltinIcon(icon: BuiltinIcon): void {
    this.iconError.set(null);
    this.setCustomIconPreview(null);
    this.applyIcon(
      { source: 'builtin', name: icon.id, mime: 'image/svg+xml' },
      icon.anchor,
    );
    this.iconGalleryOpen.set(false);
  }

  onIconFile(input: HTMLInputElement): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.iconError.set(null);
    const isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    if (!isSvg && !isPng) {
      this.iconError.set('Choose an SVG or PNG file.');
      return;
    }
    if (file.size > this.maxIconBytes) {
      this.iconError.set('Icon must be 512 KB or smaller.');
      return;
    }
    this.uploadIconFile(file, [0.5, 0.5]);
  }

  /** Stores an SVG/PNG as this layer's icon (GeoServer keeps its own copy,
   *  so the map never depends on where the icon came from). */
  private uploadIconFile(file: File, anchor: [number, number], done?: () => void): void {
    this.iconUploading.set(true);
    // Instant local preview from the picked file; the server round-trip
    // only produces the stored reference.
    this.setCustomIconPreview(URL.createObjectURL(file));
    this.styleService.uploadIcon(this.target, file).subscribe({
      next: (ref: IconRef) => {
        this.iconUploading.set(false);
        this.applyIcon(ref, anchor);
        this.iconGalleryOpen.set(false);
        done?.();
      },
      error: (error: HttpErrorResponse) => {
        this.iconUploading.set(false);
        this.setCustomIconPreview(null);
        this.iconError.set(this.msg(error));
        done?.();
      },
    });
  }

  // ---- online icons (Iconify: Google Material Symbols, Font Awesome, …) ----

  setOnlineQuery(query: string): void {
    this.onlineQuery.set(query);
    this.onlineSearch$.next();
  }

  setOnlineSource(prefixes: string): void {
    this.onlineSource.set(prefixes);
    this.onlineSearch$.next();
  }

  private runOnlineSearch(): void {
    const query = this.onlineQuery().trim();
    this.onlineError.set(null);
    if (query.length < 2) {
      this.onlineResults.set([]);
      return;
    }
    this.onlineLoading.set(true);
    const url = `${ICONIFY_API}/search?query=${encodeURIComponent(query)}&prefixes=${this.onlineSource()}&limit=96`;
    // fetch, not HttpClient: the auth interceptor must never send the
    // user's token to a third-party host.
    fetch(url)
      .then((res) => (res.ok ? res.json() : Promise.reject(res.status)))
      .then((body: { icons?: string[] }) => {
        if (query !== this.onlineQuery().trim()) return;
        this.onlineResults.set(body.icons ?? []);
        this.onlineLoading.set(false);
      })
      .catch(() => {
        this.onlineLoading.set(false);
        this.onlineResults.set([]);
        this.onlineError.set('Could not reach the online icon library. Check the internet connection.');
      });
  }

  /** Thumbnail URL of an online icon ("prefix:name"), in the chosen colour. */
  onlineIconUrl(id: string, size = 32): string {
    const [prefix, name] = id.split(':');
    return `${ICONIFY_API}/${prefix}/${name}.svg?height=${size}&color=${encodeURIComponent(this.onlineColor())}`;
  }

  onlineIconLabel(id: string): string {
    const [prefix, name] = id.split(':');
    const library = ONLINE_ICON_LIBRARIES.find((l) => l.value === prefix);
    return `${name.replace(/-/g, ' ')} — ${library ? `${library.label} (${library.license})` : prefix}`;
  }

  /** Download the icon as SVG in the chosen colour and store it as an
   *  uploaded icon of this layer. */
  pickOnlineIcon(id: string): void {
    if (this.onlinePicking() || this.iconUploading()) return;
    this.iconError.set(null);
    this.onlinePicking.set(id);
    fetch(this.onlineIconUrl(id, 64))
      .then((res) => (res.ok ? res.text() : Promise.reject(res.status)))
      .then((svg) => {
        const name = id.replace(':', '_');
        const file = new File([svg], `${name}.svg`, { type: 'image/svg+xml' });
        // Pins point with their tip; other icons sit centred on the point.
        const pin = /(^|-)(pin|marker|location-on|location-dot|place|map-pin)(-|$)/.test(id.split(':')[1]);
        this.uploadIconFile(file, pin ? [0.5, 0.95] : [0.5, 0.5], () => this.onlinePicking.set(null));
      })
      .catch(() => {
        this.onlinePicking.set(null);
        this.iconError.set('Could not download that icon. Try again.');
      });
  }

  clearIcon(): void {
    this.iconError.set(null);
    this.setCustomIconPreview(null);
    this.spec.update((spec) => {
      const symbol = { ...spec.symbol };
      delete symbol.icon;
      delete symbol.iconOpacity;
      delete symbol.iconAnchorX;
      delete symbol.iconAnchorY;
      return { ...spec, symbol };
    });
    this.touch();
  }

  private loadCustomIconPreview(name: string): void {
    this.styleService.customIconBlob(this.target, name).subscribe({
      next: (blob) => this.setCustomIconPreview(URL.createObjectURL(blob)),
      error: () => this.setCustomIconPreview(null),
    });
  }

  private setCustomIconPreview(url: string | null): void {
    if (this.customIconObjectUrl) {
      URL.revokeObjectURL(this.customIconObjectUrl);
    }
    this.customIconObjectUrl = url;
    this.customIconPreview.set(url);
  }

  ngOnDestroy(): void {
    if (this.customIconObjectUrl) URL.revokeObjectURL(this.customIconObjectUrl);
  }

  private applyIcon(icon: IconRef, anchor: [number, number]): void {
    this.spec.update((spec) => ({
      ...spec,
      symbol: {
        ...spec.symbol,
        icon,
        markSize: Math.max(spec.symbol.markSize ?? 0, 16),
        iconOpacity: spec.symbol.iconOpacity ?? 1,
        iconAnchorX: spec.symbol.iconAnchorX ?? anchor[0],
        iconAnchorY: spec.symbol.iconAnchorY ?? anchor[1],
      },
    }));
    this.touch();
  }

  patchScaleZoom(which: 'min' | 'max', zoom: number): void {
    this.spec.update((spec) => {
      const scale = { ...(spec.scale ?? {}) };
      // "min zoom" = most zoomed out = largest denominator = maxDenominator
      if (which === 'min') scale.maxDenominator = Math.round(ZOOM_TO_DENOM(zoom));
      else scale.minDenominator = Math.round(ZOOM_TO_DENOM(zoom));
      return { ...spec, scale };
    });
    this.touch();
  }

  clearScale(): void {
    this.spec.update((spec) => ({ ...spec, scale: undefined }));
    this.touch();
  }

  patchRaster(patch: Partial<LayerStyleSpec['raster']>): void {
    this.spec.update((spec) => ({
      ...spec,
      raster: {
        opacity: spec.raster?.opacity ?? 1,
        colorMap: spec.raster?.colorMap ?? [],
        ...(patch ?? {}),
      },
    }));
    this.touch();
  }

  toggleLabels(enabled: boolean): void {
    this.spec.update((spec) => ({
      ...spec,
      labels: {
        enabled,
        field: spec.labels?.field ?? this.labelFields()[0]?.value ?? '',
        font: spec.labels?.font ?? 'SansSerif',
        size: spec.labels?.size ?? 12,
        color: spec.labels?.color ?? '#1c2430',
        haloColor: spec.labels?.haloColor ?? '#ffffff',
        haloWidth: spec.labels?.haloWidth ?? 1.5,
        rotation: spec.labels?.rotation ?? 0,
        offsetX: spec.labels?.offsetX ?? 0,
        offsetY: spec.labels?.offsetY ?? 0,
        placement: spec.labels?.placement ?? (this.geometry === 'line' ? 'line' : 'point'),
      },
    }));
    this.touch();
  }

  patchLabel(patch: Partial<LayerStyleSpec['labels']>): void {
    this.spec.update((spec) =>
      spec.labels
        ? { ...spec, labels: { ...spec.labels, ...this.normalize(patch ?? {}) } }
        : spec,
    );
    this.touch();
  }

  setRamp(id: string): void {
    this.rampId.set(id);
    const spec = this.spec();
    if (spec.mode === 'graduated' && spec.graduate) {
      this.spec.update((s) => ({
        ...s,
        graduate: {
          ...s.graduate!,
          ramp: sampleRamp(this.rampColors(id), s.graduate!.classCount),
        },
      }));
      this.touch();
    } else if (spec.mode === 'categorized' && spec.categorize) {
      const colors = sampleRamp(
        this.rampColors(id),
        spec.categorize.categories.length,
      );
      this.spec.update((s) => ({
        ...s,
        categorize: {
          ...s.categorize!,
          categories: s.categorize!.categories.map((c, i) => ({
            ...c,
            symbol: { ...c.symbol, fillColor: colors[i], strokeColor: c.symbol.strokeColor },
          })),
        },
      }));
      this.touch();
    }
  }

  setCategoryColor(index: number, hex: string): void {
    this.spec.update((spec) => ({
      ...spec,
      categorize: spec.categorize
        ? {
            ...spec.categorize,
            categories: spec.categorize.categories.map((c, i) =>
              i === index
                ? { ...c, symbol: { ...c.symbol, fillColor: this.hex(hex) } }
                : c,
            ),
          }
        : spec.categorize,
    }));
    this.touch();
  }

  setBreakColor(index: number, hex: string): void {
    this.spec.update((spec) => ({
      ...spec,
      graduate: spec.graduate
        ? {
            ...spec.graduate,
            ramp: spec.graduate.ramp.map((c, i) =>
              i === index ? this.hex(hex) : c,
            ),
          }
        : spec.graduate,
    }));
    this.touch();
  }

  setBreak(index: number, value: number): void {
    this.spec.update((spec) => ({
      ...spec,
      graduate: spec.graduate
        ? {
            ...spec.graduate,
            method: 'manual',
            breaks: spec.graduate.breaks.map((b, i) => (i === index ? value : b)),
          }
        : spec.graduate,
    }));
    this.touch();
  }

  // ---- classification -----------------------------------------

  classify(): void {
    const spec = this.spec();
    const field =
      spec.mode === 'categorized'
        ? spec.categorize?.field
        : spec.graduate?.field;
    if (!field) {
      this.notify.warn('Pick a field to classify by first.');
      return;
    }
    this.classifying.set(true);
    this.errorMsg.set(null);
    const method =
      spec.mode === 'graduated'
        ? (spec.graduate?.method ?? 'quantile')
        : undefined;
    const classes = spec.mode === 'graduated' ? spec.graduate?.classCount : undefined;

    this.styleService
      .fieldStats(this.target, field, method as ClassificationMethod, classes)
      .subscribe({
        next: (stats) => {
          this.classifying.set(false);
          if (spec.mode === 'categorized') {
            if (!stats.distinct?.length) {
              this.notify.warn('That field has no values to categorize.');
              return;
            }
            const colors = sampleRamp(
              this.rampColors(this.rampId()),
              stats.distinct.length,
            );
            const categories: StyleCategory[] = stats.distinct.map((value, i) => ({
              value,
              symbol: {
                ...spec.symbol,
                fillColor: colors[i],
                strokeColor: spec.symbol.strokeColor ?? '#333333',
              },
            }));
            this.spec.update((s) => ({
              ...s,
              categorize: { ...s.categorize!, categories, includeOther: s.categorize?.includeOther ?? true },
            }));
            if (stats.distinctTruncated) {
              this.notify.info(
                'Showing the first 50 values — use Graduated for a continuous field.',
              );
            }
          } else if (stats.numeric) {
            const count = Math.max(spec.graduate?.classCount ?? 5, 2);
            this.spec.update((s) => ({
              ...s,
              graduate: {
                ...s.graduate!,
                classCount: count,
                breaks: stats.numeric!.breaks,
                ramp: sampleRamp(this.rampColors(this.rampId()), count),
              },
            }));
          }
          this.touch();
        },
        error: (error: HttpErrorResponse) => {
          this.classifying.set(false);
          this.notify.error(this.msg(error));
        },
      });
  }

  setCategorizeField(field: string): void {
    this.spec.update((spec) => ({
      ...spec,
      categorize: {
        field,
        categories: spec.categorize?.categories ?? [],
        includeOther: spec.categorize?.includeOther ?? true,
      },
    }));
  }

  setGraduateField(field: string): void {
    this.spec.update((spec) => ({
      ...spec,
      graduate: {
        field,
        method: spec.graduate?.method ?? 'quantile',
        classCount: spec.graduate?.classCount ?? 5,
        breaks: spec.graduate?.breaks ?? [],
        ramp: spec.graduate?.ramp ?? [],
      },
    }));
  }

  patchGraduate(patch: Partial<LayerStyleSpec['graduate']>): void {
    this.spec.update((spec) =>
      spec.graduate
        ? { ...spec, graduate: { ...spec.graduate, ...(patch ?? {}) } }
        : spec,
    );
  }

  toggleIncludeOther(includeOther: boolean): void {
    this.spec.update((spec) => ({
      ...spec,
      categorize: spec.categorize
        ? { ...spec.categorize, includeOther }
        : spec.categorize,
    }));
    this.touch();
  }

  // ---- actions -----------------------------------------------

  apply(auto = false): void {
    const spec = this.validated();
    if (!spec) return;
    this.state.set('applying');
    this.errorMsg.set(null);
    this.styleService.apply(this.target, spec).subscribe({
      next: (result) => {
        this.state.set('idle');
        this.hasSavedStyle.set(true);
        this.applied.emit({ styleName: result.styleName });
        if (!auto) this.notify.success('Style applied.');
        this.flushPendingLiveApply();
      },
      error: (error: HttpErrorResponse) => {
        this.state.set('error');
        this.errorMsg.set(this.msg(error));
        if (!auto) this.notify.error(this.msg(error));
        this.flushPendingLiveApply();
      },
    });
  }

  reset(): void {
    if (this.target.kind === 'layer') {
      this.state.set('loading');
      this.setCustomIconPreview(null);
      this.loadExistingStyle();
    } else {
      this.setCustomIconPreview(null);
      this.spec.set(defaultSpec(this.geometry));
    }
    this.errorMsg.set(null);
  }

  remove(): void {
    this.notify.confirmDelete({
      header: 'Remove style',
      message: `Remove the custom style from "${this.layerName || 'this layer'}"? It will fall back to the default GeoServer style.`,
      confirmLabel: 'Remove style',
      accept: () => {
        this.state.set('applying');
        this.styleService.remove(this.target).subscribe({
          next: () => {
            this.state.set('idle');
            this.hasSavedStyle.set(false);
            this.setCustomIconPreview(null);
            this.spec.set(defaultSpec(this.geometry));
            this.notify.success('Style removed.');
            this.removed.emit();
          },
          error: (error: HttpErrorResponse) => {
            this.state.set('error');
            this.notify.error(this.msg(error));
          },
        });
      },
    });
  }

  // ---- helpers ----------------------------------------------

  private touch(): void {
    this.change$.next();
  }

  private flushPendingLiveApply(): void {
    if (!this.pendingLiveApply) return;
    this.pendingLiveApply = false;
    this.apply(true);
  }

  private validated(): LayerStyleSpec | null {
    const spec = this.spec();
    if (spec.mode === 'categorized' && !spec.categorize?.categories.length) {
      this.notify.warn('Pick a field and press Classify first.');
      return null;
    }
    if (
      spec.mode === 'graduated' &&
      (!spec.graduate || spec.graduate.breaks.length < 2)
    ) {
      this.notify.warn('Pick a numeric field and press Classify first.');
      return null;
    }
    return spec;
  }

  private rampColors(id: string): string[] {
    return this.ramps.find((r) => r.id === id)?.colors ?? [];
  }

  /** p-colorPicker (hex format) yields "rrggbb" without the leading #. */
  hex(value: string): string {
    if (!value) return value;
    return value.startsWith('#') ? value : `#${value}`;
  }

  private normalize<T extends Record<string, unknown>>(patch: T): T {
    const out: Record<string, unknown> = { ...patch };
    for (const key of Object.keys(out)) {
      if (
        (key.toLowerCase().includes('color') || key === 'color') &&
        typeof out[key] === 'string'
      ) {
        out[key] = this.hex(out[key] as string);
      }
    }
    return out as T;
  }

  private fail(message: string): void {
    this.state.set('error');
    this.errorMsg.set(message);
  }

  private msg(error: HttpErrorResponse): string {
    if (error.status === 0) return 'Could not reach the styling service.';
    return (
      (error.error as { message?: string })?.message ??
      `The style could not be saved (error ${error.status || 'unknown'}).`
    );
  }
}
