import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SettingsService } from './settings.service';
import { ThemeService } from '../theme/theme.service';

export interface Shortcut {
  id: string;
  /** Human chord, e.g. `?`, `g s`, `[`. Two-key chords are "prefix then key". */
  keys: string;
  label: string;
  group: string;
  run: () => void;
}

/**
 * Global keyboard shortcuts (Settings → Keyboard Shortcuts). A tiny
 * extensible registry + one `keydown` listener that ignores typing in form
 * fields. Master on/off comes from `settings.shortcuts.enabled`. Register
 * more from anywhere with `register()`; the Settings section lists whatever
 * is registered.
 */
@Injectable({ providedIn: 'root' })
export class ShortcutService {
  private readonly router = inject(Router);
  private readonly settings = inject(SettingsService);
  private readonly theme = inject(ThemeService);

  private readonly registry = new Map<string, Shortcut>();
  readonly shortcuts = signal<Shortcut[]>([]);

  /** Set true while the shortcuts help overlay should be visible. */
  readonly helpOpen = signal(false);

  private prefix: string | null = null;
  private prefixAt = 0;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    this.register(
      { id: 'help', keys: '?', label: 'Show keyboard shortcuts', group: 'General', run: () => this.helpOpen.set(true) },
      { id: 'goto-settings', keys: 'g s', label: 'Open Settings', group: 'Navigation', run: () => this.router.navigate(['/settings']) },
      { id: 'goto-gis', keys: 'g m', label: 'Open Municipal GIS', group: 'Navigation', run: () => this.router.navigate(['/gis']) },
      { id: 'goto-dashboard', keys: 'g d', label: 'Open Dashboard', group: 'Navigation', run: () => this.router.navigate(['/dashboard']) },
      { id: 'goto-layers', keys: 'g l', label: 'Open GIS Layers', group: 'Navigation', run: () => this.router.navigate(['/gis/layers']) },
      {
        id: 'toggle-theme',
        keys: '[',
        label: 'Toggle light / dark theme',
        group: 'Appearance',
        run: () =>
          this.settings.patch({
            appearance: { theme: this.theme.resolvedTheme() === 'dark' ? 'light' : 'dark' },
          }),
      },
    );

    window.addEventListener('keydown', (e) => this.onKeydown(e));
  }

  register(...shortcuts: Shortcut[]): void {
    for (const s of shortcuts) this.registry.set(s.id, s);
    this.shortcuts.set([...this.registry.values()]);
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.settings.shortcutsEnabled()) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (this.isTyping(e.target)) return;

    const key = e.key === '?' ? '?' : e.key.toLowerCase();

    // Escape always closes the help overlay.
    if (e.key === 'Escape' && this.helpOpen()) {
      this.helpOpen.set(false);
      return;
    }

    // second key of a two-key chord?
    if (this.prefix && Date.now() - this.prefixAt < 1200) {
      const chord = `${this.prefix} ${key}`;
      this.prefix = null;
      const hit = [...this.registry.values()].find((s) => s.keys === chord);
      if (hit) {
        e.preventDefault();
        hit.run();
        return;
      }
    }
    this.prefix = null;

    // prefix key (currently only "g")
    if (key === 'g') {
      this.prefix = 'g';
      this.prefixAt = Date.now();
      return;
    }

    const hit = [...this.registry.values()].find((s) => s.keys === key);
    if (hit) {
      e.preventDefault();
      hit.run();
    }
  }

  private isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    if (!el) return false;
    const tag = el.tagName;
    return (
      tag === 'INPUT' ||
      tag === 'TEXTAREA' ||
      tag === 'SELECT' ||
      el.isContentEditable
    );
  }
}
