import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject, debounceTime } from 'rxjs';
import { environment } from '../../../environments/environment';
import { AppSettings, DeepPartial } from '../settings/app-settings.model';
import { SETTINGS_DEFAULTS, cloneDefaults, mergeSettings } from '../settings/settings-defaults';

/** localStorage key — also read by the anti-flash snippet in index.html. */
export const SETTINGS_STORAGE_KEY = 'mgp.settings';

/**
 * The single source of truth for per-user application settings.
 *
 * State lives in a signal, seeded synchronously from a localStorage mirror
 * so appearance can apply on first paint; `load()` then reconciles with the
 * backend (the real source of truth). `patch()` applies instantly to the
 * signal + mirror and debounces the network write. Consumers read the
 * `settings` signal or one of the typed `computed` selectors — they never
 * talk to the API directly.
 */
@Injectable({ providedIn: 'root' })
export class SettingsService {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiUrl}/me/settings`;

  private readonly state = signal<AppSettings>(readMirror() ?? cloneDefaults());
  /** Read-only view of the current settings. */
  readonly settings = this.state.asReadonly();
  /** `true` once the backend copy has been loaded at least once this session. */
  readonly loaded = signal(false);

  private readonly flush$ = new Subject<void>();

  constructor() {
    this.flush$.pipe(debounceTime(600)).subscribe(() => {
      this.http.patch(this.url, this.state()).subscribe({ error: () => undefined });
    });
  }

  /** Reconcile with the backend. Safe to call once authenticated. */
  load(): void {
    this.http.get<{ settings: DeepPartial<AppSettings> }>(this.url).subscribe({
      next: ({ settings }) => {
        this.setAll(mergeSettings(settings));
        this.loaded.set(true);
      },
      error: () => this.loaded.set(true),
    });
  }

  /**
   * Deep-merge `partial` into the current settings. Applies immediately
   * (signal + localStorage) and schedules a debounced server write.
   */
  patch(partial: DeepPartial<AppSettings>): void {
    this.setAll(deepMerge(structuredClone(this.state()), partial));
    this.flush$.next();
  }

  /** "Reset Application Settings" — back to defaults, and drop the server row. */
  reset(): void {
    this.setAll(cloneDefaults());
    this.http.delete(this.url).subscribe({ error: () => undefined });
  }

  private setAll(next: AppSettings): void {
    this.state.set(next);
    writeMirror(next);
  }

  // ---- typed selectors used across the app --------------------------------

  readonly theme = computed(() => this.state().appearance.theme);
  readonly colorTheme = computed(() => this.state().appearance.colorTheme);
  readonly density = computed(() => this.state().appearance.density);
  readonly appearance = computed(() => this.state().appearance);
  readonly accessibility = computed(() => this.state().accessibility);
  readonly locale = computed(() => this.state().locale);
  readonly map = computed(() => this.state().map);
  readonly mapUnits = computed(() => this.state().map.units);
  readonly coordinateFormat = computed(() => this.state().map.coordinateFormat);
  readonly notifications = computed(() => this.state().notifications);
  readonly session = computed(() => this.state().session);
  readonly shortcutsEnabled = computed(() => this.state().shortcuts.enabled);
}

// ---- helpers -------------------------------------------------------------

function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  const out = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    if (value === undefined) continue;
    const current = out[key];
    if (isRecord(value) && isRecord(current)) {
      deepMerge(current, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return target;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMirror(): AppSettings | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return raw ? mergeSettings(JSON.parse(raw) as DeepPartial<AppSettings>) : null;
  } catch {
    return null;
  }
}

function writeMirror(settings: AppSettings): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — the DB copy is authoritative anyway */
  }
}

export { SETTINGS_DEFAULTS };
