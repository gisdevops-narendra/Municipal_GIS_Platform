import { Component, computed, effect, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { Toast } from 'primeng/toast';
import { ConfirmDialog } from 'primeng/confirmdialog';
import { Dialog } from 'primeng/dialog';
import { AuthService } from './core/services/auth.service';
import { AppRouteReuseStrategy } from './core/routing/app-route-reuse.strategy';
import { SettingsService } from './core/services/settings.service';
import { SessionService } from './core/services/session.service';
import { ShortcutService } from './core/services/shortcut.service';
import { ThemeService } from './core/theme/theme.service';

/**
 * Application shell. Hosts the single `<p-toast>` / `<p-confirmdialog>`
 * instances that back `NotificationService`, plus the global keyboard-
 * shortcut help overlay. Also the place the cross-cutting services are
 * kicked off: `ThemeService` (appearance), `SettingsService.load()` once
 * authenticated, `SessionService` (idle logout) and `ShortcutService`.
 */
@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, Toast, ConfirmDialog, Dialog],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss'
})
export class AppComponent {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly session = inject(SessionService);
  private readonly routeReuse = inject(AppRouteReuseStrategy);
  readonly shortcuts = inject(ShortcutService);
  // Injected for its constructor side-effect (starts the appearance effect).
  private readonly theme = inject(ThemeService);

  readonly toastPosition = computed(() => this.settings.notifications().toastPosition);
  readonly toastLife = computed(() => this.settings.notifications().toastDuration);

  private settingsLoaded = false;

  constructor() {
    this.session.start();
    this.shortcuts.start();

    effect(() => {
      if (this.auth.isAuthenticated()) {
        if (!this.settingsLoaded) {
          this.settingsLoaded = true;
          this.settings.load();
        }
      } else if (this.settingsLoaded) {
        // Session ended — drop every keep-alive'd screen so the next user
        // on this tab starts clean.
        this.settingsLoaded = false;
        this.routeReuse.clear();
      }
    });
    // keep a reference so the linter doesn't flag `theme` as unused
    void this.theme;
  }
}
