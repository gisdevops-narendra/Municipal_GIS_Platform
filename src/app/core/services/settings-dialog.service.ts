import { Injectable, signal } from '@angular/core';
import { SETTINGS_TABS, tabForSection } from '../settings/settings-sections';

/** Opens the Settings window (a dialog over the current page, like the
 *  settings in Claude / ChatGPT) from anywhere: account menu, shortcut,
 *  or an old `/settings?section=…` link. */
@Injectable({ providedIn: 'root' })
export class SettingsDialogService {
  readonly isOpen = signal(false);
  readonly tab = signal<string>(SETTINGS_TABS[0].id);

  /** `target` may be a tab id or an old section id (e.g. 'basemap'). */
  open(target?: string | null): void {
    if (target) this.tab.set(tabForSection(target));
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }
}
