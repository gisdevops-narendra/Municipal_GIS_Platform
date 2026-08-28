import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { ShortcutService } from '../../../core/services/shortcut.service';

/** Settings → Help & Documentation. In-app signposting only — no external
 *  links are wired yet. */
@Component({
  selector: 'app-help-section',
  standalone: true,
  imports: [ButtonModule],
  template: `
    <div class="cards">
      <div class="card">
        <h3>Keyboard shortcuts</h3>
        <p>Press <kbd>?</kbd> anywhere in the app for the full list, or open it here.</p>
        <button pButton type="button" class="p-button-sm p-button-outlined" label="Show shortcuts" (click)="openShortcuts()"></button>
      </div>

      <div class="card">
        <h3>Managing users &amp; layers</h3>
        <p>
          User accounts, departments and layer permissions are administered from the
          Users, Departments and GIS Layers screens by your Municipality Owner or a
          department head.
        </p>
        <button pButton type="button" class="p-button-sm p-button-text" label="Go to Users" (click)="go('/users')"></button>
      </div>

      <div class="card">
        <h3>Something not working?</h3>
        <p>
          Check <strong>System Status</strong> in this Settings screen — if a component
          shows as down, map tiles or saves may be temporarily unavailable. Otherwise
          contact your platform administrator.
        </p>
      </div>
    </div>
  `,
  styles: [
    `
      .cards {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .card {
        padding: 16px 18px;
        border: 1px solid var(--color-line);
        border-radius: var(--radius-sm);
        background: var(--color-surface);
      }
      .card h3 {
        font-size: 14px;
        margin: 0 0 6px;
      }
      .card p {
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--color-ink-500);
        margin: 0 0 10px;
      }
      kbd {
        font-family: var(--font-mono);
        font-size: 11px;
        padding: 1px 5px;
        border: 1px solid var(--color-line-strong);
        border-radius: var(--radius-sm);
        background: var(--color-surface-alt);
      }
    `,
  ],
})
export class HelpSectionComponent {
  private readonly shortcuts = inject(ShortcutService);
  private readonly router = inject(Router);

  openShortcuts(): void {
    this.shortcuts.helpOpen.set(true);
  }

  go(path: string): void {
    this.router.navigate([path]);
  }
}
