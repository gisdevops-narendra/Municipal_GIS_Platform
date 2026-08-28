import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { SessionSettings } from '../../../core/settings/app-settings.model';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { SettingToggleComponent } from '../ui/setting-toggle.component';
import { AUTO_LOGOUT_OPTIONS } from '../settings.data';

/** Settings → Session & Auto Logout. Enforced by `SessionService` (idle
 *  pointer/keyboard timer, started once from the app shell). */
@Component({
  selector: 'app-session-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent, SettingToggleComponent],
  template: `
    <app-setting-field
      label="Sign out when idle"
      hint="Signs you out through Keycloak after this much time with no mouse or keyboard activity."
    >
      <p-select
        [options]="options"
        optionLabel="label"
        optionValue="value"
        [ngModel]="session().autoLogoutMinutes"
        (ngModelChange)="patch({ autoLogoutMinutes: $event })"
        appendTo="body"
      />
    </app-setting-field>

    @if (session().autoLogoutMinutes > 0) {
      <app-setting-toggle
        label="Warn before signing out"
        hint="Shows a warning 60 seconds before the automatic sign-out."
        [value]="session().warnBeforeLogout"
        (valueChange)="patch({ warnBeforeLogout: $event })"
      />
    }
  `,
})
export class SessionSectionComponent {
  private readonly s = inject(SettingsService);
  readonly session = this.s.session;
  readonly options = AUTO_LOGOUT_OPTIONS;

  patch(session: Partial<SessionSettings>): void {
    this.s.patch({ session });
  }
}
