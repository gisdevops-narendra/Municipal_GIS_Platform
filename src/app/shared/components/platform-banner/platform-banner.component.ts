import { Component, computed, inject, signal } from '@angular/core';
import { PlatformService } from '../../../core/services/platform.service';

/** The Admin announcement banner (dismissible per message) and the
 *  maintenance notice, shown above every page. */
@Component({
  selector: 'app-platform-banner',
  standalone: true,
  template: `
    @if (platform.maintenance(); as m) {
      <div class="pb" data-level="critical" role="alert">
        <i class="pi pi-wrench" aria-hidden="true"></i>
        <span><b>Maintenance:</b> {{ m.message }}</span>
      </div>
    }
    @if (visibleAnnouncement(); as a) {
      <div class="pb" [attr.data-level]="a.level ?? 'info'" role="status">
        <i class="pi" [class.pi-info-circle]="a.level === 'info'" [class.pi-exclamation-triangle]="a.level !== 'info'" aria-hidden="true"></i>
        <span>{{ a.message }}</span>
        <button type="button" class="pb__close" aria-label="Dismiss" (click)="dismiss(a.message)"><i class="pi pi-times"></i></button>
      </div>
    }
  `,
  styles: `
    :host { display: block; position: relative; z-index: 1100; }
    .pb { display: flex; align-items: center; gap: 10px; padding: 8px 16px; font-size: 13px; line-height: 1.4; }
    .pb[data-level='info'] { background: #eff6ff; color: #1e3a8a; }
    .pb[data-level='warning'] { background: #fef3c7; color: #78350f; }
    .pb[data-level='critical'] { background: #fee2e2; color: #7f1d1d; }
    .pb span { flex: 1; }
    .pb__close { border: 0; background: transparent; color: inherit; cursor: pointer; padding: 4px; }
  `
})
export class PlatformBannerComponent {
  readonly platform = inject(PlatformService);
  private readonly dismissed = signal<string | null>(readDismissed());

  readonly visibleAnnouncement = computed(() => {
    const a = this.platform.announcement();
    return a && a.message !== this.dismissed() ? a : null;
  });

  dismiss(message: string): void {
    this.dismissed.set(message);
    try {
      sessionStorage.setItem('mgp.banner.dismissed', message);
    } catch {
      /* not remembered */
    }
  }
}

function readDismissed(): string | null {
  try {
    return sessionStorage.getItem('mgp.banner.dismissed');
  } catch {
    return null;
  }
}
