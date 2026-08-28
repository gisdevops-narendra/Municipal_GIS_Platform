import { Injectable, effect, inject } from '@angular/core';
import { updatePrimaryPalette } from '@primeuix/themes';
import { SettingsService } from '../services/settings.service';
import { colorTheme } from '../settings/color-themes';
import type { ThemeMode } from '../settings/app-settings.model';

/**
 * Applies the appearance + accessibility settings to the live document.
 * Everything is a class / `data-*` attribute / CSS custom property on
 * `<html>` — the actual values live in `src/styles.scss`. Instantiated once
 * from `AppComponent`; an `effect()` re-applies on every settings change,
 * and a `matchMedia` listener keeps "System" in sync with the OS.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly settings = inject(SettingsService);
  private readonly root = document.documentElement;
  private readonly systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  private lastPaletteId = '';

  constructor() {
    this.systemDark.addEventListener('change', () => {
      if (this.settings.theme() === 'system') this.apply();
    });
    effect(() => {
      // touch every signal the appliers read so the effect re-runs on change
      this.settings.appearance();
      this.settings.accessibility();
      this.apply();
    });
  }

  /** Force-resolve the current theme (used by the "toggle theme" shortcut). */
  resolvedTheme(): 'light' | 'dark' {
    return this.resolve(this.settings.theme());
  }

  private apply(): void {
    const a = this.settings.appearance();
    const acc = this.settings.accessibility();

    const dark = this.resolve(a.theme) === 'dark';
    this.root.setAttribute('data-theme', dark ? 'dark' : 'light');
    this.root.setAttribute('data-color-theme', a.colorTheme);
    this.root.setAttribute('data-density', a.density);
    this.toggleAttr('data-contrast', 'high', acc.highContrast);
    this.root.style.setProperty('--font-scale', String(a.fontScale));

    this.root.classList.toggle('mgp-reduce-motion', acc.reduceMotion);
    this.root.classList.toggle('mgp-underline-links', acc.underlineLinks);
    this.root.classList.toggle('mgp-large-targets', acc.largeTargets);

    const theme = colorTheme(a.colorTheme);
    for (const [prop, value] of Object.entries(theme.tokens)) {
      // In dark mode the light "wash" tokens (…-100) would glow as
      // backgrounds — let the dark rules in styles.scss own those instead.
      if (dark && prop.endsWith('-100')) {
        this.root.style.removeProperty(prop);
      } else {
        this.root.style.setProperty(prop, value);
      }
    }
    if (this.lastPaletteId !== a.colorTheme) {
      this.lastPaletteId = a.colorTheme;
      updatePrimaryPalette(theme.primary);
    }
  }

  private resolve(mode: ThemeMode): 'light' | 'dark' {
    if (mode === 'system') return this.systemDark.matches ? 'dark' : 'light';
    return mode;
  }

  private toggleAttr(name: string, value: string, on: boolean): void {
    if (on) this.root.setAttribute(name, value);
    else this.root.removeAttribute(name);
  }
}
