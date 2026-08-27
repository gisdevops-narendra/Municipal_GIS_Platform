import { Component, Input, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { AuthService } from '../../../core/services/auth.service';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { CurrentUser } from '../../../core/models/current-user.model';

const ROLE_LABELS: Record<CurrentUser['systemRole'], string> = {
  MUNICIPALITY_OWNER: 'Municipality Owner',
  DEPARTMENT_HEAD: 'Department Head',
  DEPARTMENT_USER: 'Department User'
};

@Component({
  selector: 'app-site-header',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, ButtonModule],
  templateUrl: './site-header.component.html',
  styleUrl: './site-header.component.scss'
})
export class SiteHeaderComponent {
  /** Hides the account / nav area on screens that already are the login or
   *  registration flow, to avoid redundant navigation. */
  @Input() showActions = true;

  private readonly auth = inject(AuthService);
  private readonly currentUserService = inject(CurrentUserService);

  readonly isAuthenticated = this.auth.isAuthenticated;
  readonly user = this.auth.user;

  /** Best-effort enrichment of the profile chip (real name + role +
   *  municipality) from GET /api/me. Failure is silent — the chip falls
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

  readonly roleLabel = computed(() => {
    const me = this.me();
    return me ? ROLE_LABELS[me.systemRole] : '';
  });

  readonly secondaryLine = computed(() => {
    const me = this.me();
    if (me) {
      return me.municipality?.name ?? this.user()?.email ?? '';
    }
    return this.user()?.email ?? '';
  });

  readonly initials = computed(() => {
    const source = this.displayName().replace(/@.*/, '').trim();
    const parts = source.split(/[\s._-]+/).filter(Boolean);
    const picked = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : source.slice(0, 2)) || '?';
    return picked.toUpperCase();
  });

  logout(): void {
    this.auth.logout();
  }
}
