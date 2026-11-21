import { Component, HostListener, Input, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgTemplateOutlet } from '@angular/common';
import { ButtonModule } from 'primeng/button';
import { AuthService } from '../../../core/services/auth.service';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { CurrentUser } from '../../../core/models/current-user.model';
import { ThemeService } from '../../../core/theme/theme.service';
import { SettingsService } from '../../../core/services/settings.service';

/** Primary menu: Create Account → Login → Upload → View on map. */
const NAV: NavItem[] = [
  { label: 'Map', route: '/gis', exact: true }
];

export interface NavItem {
  label: string;
  route: string;
  exact: boolean;
}

@Component({
  selector: 'app-site-header',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, NgTemplateOutlet, ButtonModule],
  templateUrl: './site-header.component.html',
  styleUrl: './site-header.component.scss'
})
export class SiteHeaderComponent {
  /** Hides the account / nav area on screens that already are the login or
   *  registration flow, to avoid redundant navigation. */
  @Input() showActions = true;
  /** One-row header (brand · menu · account menu) for full-screen work
   *  pages like the Municipal GIS map. */
  @Input({ transform: (v: boolean | string) => v !== false && v !== 'false' }) compact = false;
  /** Only the account button + menu (no header bar) — embedded in the
   *  map toolbar so the map page has no separate header row. */
  @Input({ transform: (v: boolean | string) => v !== false && v !== 'false' }) accountOnly = false;
  readonly accountOpen = signal(false);
  private readonly theme = inject(ThemeService);
  private readonly settings = inject(SettingsService);
  readonly isDark = computed(() => {
    this.settings.theme();
    return this.theme.resolvedTheme() === 'dark';
  });

  toggleTheme(): void {
    this.settings.patch({ appearance: { theme: this.isDark() ? 'light' : 'dark' } });
  }

  private readonly auth = inject(AuthService);
  private readonly currentUserService = inject(CurrentUserService);

  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly user = this.auth.user;

  /** Best-effort enrichment of the profile chip (real name + email)
   *  from GET /api/me. Failure is silent — the chip falls
   *  back to the Keycloak token's name/email. */
  private readonly me = signal<CurrentUser | null>(null);
  private meRequested = false;

  constructor() {
    effect(() => {
      if (this.isAuthenticated() && !this.meRequested) {
        this.meRequested = true;
        this.currentUserService.getMe().subscribe({
          next: (user) => this.me.set(user),
          error: () => undefined
        });
      }
    });
    // A profile edit (Settings → Profile) updates the chip right away.
    effect(() => {
      const updated = this.currentUserService.updated();
      if (updated) this.me.set(updated);
    });
  }

  readonly displayName = computed(() => {
    const me = this.me();
    if (me?.name) {
      return me.name;
    }
    const token = this.user();
    if (!token) {
      return '';
    }
    const full = [token.firstName, token.lastName].filter(Boolean).join(' ').trim();
    return full || token.username || token.email || '';
  });

  readonly navItems = NAV;

  readonly secondaryLine = computed(() => {
    const me = this.me();
    return me?.email ?? this.user()?.email ?? '';
  });

  readonly initials = computed(() => {
    const source = this.displayName().replace(/@.*/, '').trim();
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    const picked = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)) || '?';
    return picked.toUpperCase();
  });

  @HostListener('document:keydown.escape')
  closeAccountMenu(): void {
    this.accountOpen.set(false);
  }

  logout(): void {
    this.accountOpen.set(false);
    this.auth.logout();
  }
}
