import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { ButtonModule } from 'primeng/button';
import { SettingsService } from '../../../core/services/settings.service';
import { NotificationSettings, NOTIFICATION_CATEGORIES } from '../../../core/settings/app-settings.model';
import { NotificationService } from '../../../core/services/notification.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { SettingToggleComponent } from '../ui/setting-toggle.component';
import { TOAST_POSITION_OPTIONS } from '../settings.data';

/** Settings → Notifications. Position + duration feed the global `<p-toast>`
 *  host; the category toggles are honoured by `NotificationService` (errors
 *  are never suppressed). */
@Component({
  selector: 'app-notifications-section',
  standalone: true,
  imports: [
    FormsModule,
    SelectModule,
    SliderModule,
    ButtonModule,
    SettingFieldComponent,
    SettingToggleComponent,
  ],
  template: `
    <app-setting-field label="Position" hint="Where toast messages appear on screen.">
      <p-select
        [options]="positions"
        optionLabel="label"
        optionValue="value"
        [ngModel]="n().toastPosition"
        (ngModelChange)="patch({ toastPosition: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-field
      label="On-screen time"
      [hint]="'How long an informational toast stays visible — currently ' + seconds(n().toastDuration)"
      [stack]="true"
    >
      <p-slider
        [min]="1000"
        [max]="15000"
        [step]="500"
        [ngModel]="n().toastDuration"
        (ngModelChange)="patch({ toastDuration: $event })"
      />
    </app-setting-field>

    <app-setting-field label="Try it" hint="Send a sample notification with the current settings.">
      <button pButton type="button" class="p-button-sm p-button-outlined" label="Send test" (click)="test()"></button>
    </app-setting-field>

    <h3 class="subhead">Which events notify you</h3>
    <p class="muted">Failures and warnings always show regardless of these toggles.</p>
    @for (c of categories; track c.id) {
      <app-setting-toggle
        [label]="c.label"
        [value]="n().categories[c.id] !== false"
        (valueChange)="setCategory(c.id, $event)"
      />
    }
  `,
  styles: [
    `
      .subhead {
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--color-ink-500);
        margin: 24px 0 4px;
      }
      .muted {
        font-size: 12.5px;
        color: var(--color-ink-500);
        margin: 0 0 8px;
      }
    `,
  ],
})
export class NotificationsSectionComponent {
  private readonly s = inject(SettingsService);
  private readonly notify = inject(NotificationService);
  readonly n = this.s.notifications;
  readonly positions = TOAST_POSITION_OPTIONS;
  readonly categories = NOTIFICATION_CATEGORIES;

  patch(notifications: Partial<NotificationSettings>): void {
    this.s.patch({ notifications });
  }

  setCategory(id: string, on: boolean): void {
    this.s.patch({ notifications: { categories: { ...this.n().categories, [id]: on } } });
  }

  seconds(ms: number): string {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  test(): void {
    this.notify.success('This is how your notifications will look.', 'Test notification');
  }
}
