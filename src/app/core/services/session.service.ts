import { DestroyRef, Injectable, inject } from '@angular/core';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';
import { SettingsService } from './settings.service';

const CHECK_INTERVAL_MS = 15_000;
const WARN_LEAD_MS = 60_000;

/**
 * Idle auto-logout (Settings → Session). When
 * `session.autoLogoutMinutes > 0`, signs the user out through Keycloak
 * after that many minutes with no pointer/keyboard activity, optionally
 * showing a 60-second warning first. A no-op when the setting is `0` (the
 * default) or while unauthenticated. Started once from `AppComponent`.
 */
@Injectable({ providedIn: 'root' })
export class SessionService {
  private readonly auth = inject(AuthService);
  private readonly settings = inject(SettingsService);
  private readonly notify = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  private lastActivity = Date.now();
  private warned = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    const bump = () => {
      this.lastActivity = Date.now();
      this.warned = false;
    };
    for (const evt of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
      window.addEventListener(evt, bump, { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') bump();
    });

    // One lightweight interval; `tick()` reads the current setting each time
    // and self-disables when auto-logout is off.
    this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
    this.destroyRef.onDestroy(() => {
      if (this.timer) clearInterval(this.timer);
    });
  }

  private tick(): void {
    const { autoLogoutMinutes, warnBeforeLogout } = this.settings.session();
    if (!this.auth.isAuthenticated() || autoLogoutMinutes <= 0) {
      return;
    }
    const idle = Date.now() - this.lastActivity;
    const limit = autoLogoutMinutes * 60_000;

    if (idle >= limit) {
      this.lastActivity = Date.now(); // avoid a re-fire loop during redirect
      void this.auth.logout();
      return;
    }
    if (warnBeforeLogout && !this.warned && idle >= limit - WARN_LEAD_MS) {
      this.warned = true;
      this.notify.warn(
        'You will be signed out shortly due to inactivity. Move the mouse or press a key to stay signed in.',
        'Session about to expire',
      );
    }
  }
}
