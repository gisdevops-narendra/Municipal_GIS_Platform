import { Component, inject } from '@angular/core';
import { ButtonModule } from 'primeng/button';
import { SettingsService } from '../../../core/services/settings.service';
import { NotificationService } from '../../../core/services/notification.service';

/** Settings → Reset Settings. Restores every preference on this screen to
 *  its default and drops the stored row on the server. Does not touch your
 *  profile, account or any GIS data. */
@Component({
  selector: 'app-reset-section',
  standalone: true,
  imports: [ButtonModule],
  template: `
    <div class="panel">
      <p>
        This restores every setting on this screen — appearance, regional formats, map
        defaults, notifications and session — to its original value, and removes your
        saved preferences from the server. It does <strong>not</strong> affect your
        profile, your account, or any GIS layers or data.
      </p>
      <button
        pButton
        type="button"
        class="p-button-danger p-button-outlined"
        icon="pi pi-refresh"
        label="Reset all settings to defaults"
        (click)="confirmReset()"
      ></button>
    </div>
  `,
  styles: [
    `
      .panel {
        padding: 18px 20px;
        border: 1px solid var(--color-error-100);
        border-radius: var(--radius-sm);
        background: var(--color-error-100);
      }
      .panel p {
        margin: 0 0 14px;
        font-size: 12.5px;
        line-height: 1.6;
        color: var(--color-ink-700);
      }
    `,
  ],
})
export class ResetSectionComponent {
  private readonly settings = inject(SettingsService);
  private readonly notify = inject(NotificationService);

  confirmReset(): void {
    this.notify.confirm({
      header: 'Reset all settings?',
      message:
        'Every preference on this screen will go back to its default. This cannot be undone.',
      confirmLabel: 'Reset settings',
      cancelLabel: 'Keep my settings',
      destructive: true,
      accept: () => {
        this.settings.reset();
        this.notify.success('All settings have been restored to their defaults.', 'Settings reset');
      },
    });
  }
}
