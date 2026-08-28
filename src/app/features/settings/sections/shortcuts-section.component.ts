import { Component, computed, inject } from '@angular/core';
import { SettingsService } from '../../../core/services/settings.service';
import { Shortcut, ShortcutService } from '../../../core/services/shortcut.service';
import { SettingToggleComponent } from '../ui/setting-toggle.component';

/** Settings → Keyboard Shortcuts. Master on/off plus a read-only list of
 *  every shortcut currently registered with `ShortcutService`. */
@Component({
  selector: 'app-shortcuts-section',
  standalone: true,
  imports: [SettingToggleComponent],
  template: `
    <app-setting-toggle
      label="Enable keyboard shortcuts"
      hint="Global shortcuts such as “?” for help and “g s” to jump to Settings. Typing in a field is never intercepted."
      [value]="s.shortcutsEnabled()"
      (valueChange)="s.patch({ shortcuts: { enabled: $event } })"
    />

    @if (s.shortcutsEnabled()) {
      @for (group of groups(); track group.name) {
        <h3 class="subhead">{{ group.name }}</h3>
        <ul class="rows">
          @for (sc of group.items; track sc.id) {
            <li class="row">
              <kbd>{{ sc.keys }}</kbd>
              <span>{{ sc.label }}</span>
            </li>
          }
        </ul>
      }
    }
  `,
  styles: [
    `
      .subhead {
        font-size: 12px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-ink-500);
        margin: 20px 0 6px;
      }
      .rows {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .row {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 7px 0;
        border-bottom: 1px solid var(--color-line);
        font-size: 13px;
        color: var(--color-ink-700);
      }
      kbd {
        flex: 0 0 auto;
        min-width: 3rem;
        text-align: center;
        font-family: var(--font-mono);
        font-size: 12px;
        padding: 3px 8px;
        border: 1px solid var(--color-line-strong);
        border-radius: var(--radius-sm);
        background: var(--color-surface-alt);
        color: var(--color-ink-900);
      }
    `,
  ],
})
export class ShortcutsSectionComponent {
  readonly s = inject(SettingsService);
  private readonly shortcuts = inject(ShortcutService);

  readonly groups = computed(() => {
    const byGroup = new Map<string, { name: string; items: Shortcut[] }>();
    for (const sc of this.shortcuts.shortcuts()) {
      const bucket = byGroup.get(sc.group) ?? { name: sc.group, items: [] };
      bucket.items.push(sc);
      byGroup.set(sc.group, bucket);
    }
    return [...byGroup.values()];
  });
}
