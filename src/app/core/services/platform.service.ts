import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { environment } from '../../../environments/environment';

export interface PublicBranding {
  platformName: string;
  tagline: string;
  loginMessage: string;
  primaryColor: string | null;
  hasLogo: boolean;
  logoVersion: number;
}

export interface PublicNotice {
  message: string;
  level?: 'info' | 'warning' | 'critical';
}

/**
 * Platform-wide settings from Admin: branding (name, logo, colour), the
 * announcement banner and maintenance mode (public, loaded at start-up),
 * tools switched off for the signed-in user, and tool-usage counting.
 */
@Injectable({ providedIn: 'root' })
export class PlatformService {
  private readonly http = inject(HttpClient);
  private readonly base = `${environment.apiUrl}/platform`;

  readonly branding = signal<PublicBranding>({ platformName: 'Municipal GIS', tagline: '', loginMessage: '', primaryColor: null, hasLogo: false, logoVersion: 0 });
  readonly announcement = signal<PublicNotice | null>(null);
  readonly maintenance = signal<PublicNotice | null>(null);
  /** workspace tool ids switched off for this user */
  readonly disabledTools = signal<ReadonlySet<string>>(new Set());

  private usage: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.refresh();
    // Notices change rarely; re-check every 5 minutes.
    setInterval(() => this.refresh(), 5 * 60_000);
  }

  refresh(): void {
    this.http.get<{ branding: PublicBranding; announcement: PublicNotice | null; maintenance: PublicNotice | null }>(`${this.base}/public`).subscribe({
      next: (p) => {
        this.branding.set(p.branding);
        this.announcement.set(p.announcement);
        this.maintenance.set(p.maintenance);
        this.applyBranding(p.branding);
      },
      error: () => undefined
    });
  }

  logoUrl(): string | null {
    const b = this.branding();
    return b.hasLogo ? `${this.base}/logo?v=${b.logoVersion}` : null;
  }

  private applyBranding(b: PublicBranding): void {
    const root = document.documentElement.style;
    if (b.primaryColor && /^#[0-9a-f]{6}$/i.test(b.primaryColor)) {
      root.setProperty('--color-primary-600', b.primaryColor);
      root.setProperty('--color-primary-700', shade(b.primaryColor, -0.22));
      root.setProperty('--color-primary-500', shade(b.primaryColor, 0.15));
    } else {
      ['--color-primary-600', '--color-primary-700', '--color-primary-500'].forEach((v) => root.removeProperty(v));
    }
    if (b.platformName && !document.title.includes(b.platformName)) {
      document.title = document.title.replace(/Municipal GIS( Platform)?/, b.platformName) || b.platformName;
    }
  }

  /** Tools switched off in Admin → Modules for the signed-in user. */
  loadMyModules(): void {
    this.http.get<{ disabled: string[] }>(`${this.base}/modules/me`).subscribe({
      next: (r) => this.disabledTools.set(new Set(r.disabled)),
      error: () => undefined
    });
  }

  /** Counts a tool being opened (sent in batches, for Admin → Analytics). */
  trackTool(id: string): void {
    if (!/^[a-z0-9:-]{1,60}$/.test(id)) return;
    this.usage.push(id);
    this.flushTimer ??= setInterval(() => this.flush(), 60_000);
    if (this.usage.length >= 40) this.flush();
  }

  private flush(): void {
    if (!this.usage.length) return;
    const tools = this.usage.splice(0, 50);
    this.http.post(`${this.base}/usage`, { tools }).subscribe({ error: () => undefined });
  }
}

/** Lightens (amount > 0) or darkens (amount < 0) a #rrggbb colour. */
function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) =>
    Math.round(amount < 0 ? c * (1 + amount) : c + (255 - c) * amount)
  );
  return `#${ch.map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0')).join('')}`;
}
