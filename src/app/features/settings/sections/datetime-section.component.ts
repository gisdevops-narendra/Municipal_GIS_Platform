import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { LocaleSettings } from '../../../core/settings/app-settings.model';
import { FormatService } from '../../../core/services/format.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { DATE_FORMAT_OPTIONS, TIME_FORMAT_OPTIONS } from '../settings.data';

/** Settings → Date & Time Format. The live preview reads back through
 *  `FormatService`, exactly as the rest of the app does. */
@Component({
  selector: 'app-datetime-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field label="Date format" hint="How dates are shown in tables, feature info and the map status bar.">
      <p-select
        [options]="dateFormats"
        optionLabel="label"
        optionValue="value"
        [ngModel]="locale().dateFormat"
        (ngModelChange)="patch({ dateFormat: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-field label="Time format">
      <p-select
        [options]="timeFormats"
        optionLabel="label"
        optionValue="value"
        [ngModel]="locale().timeFormat"
        (ngModelChange)="patch({ timeFormat: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <p class="preview">
      Preview: <strong>{{ fmt.dateTime(now) }}</strong>
    </p>
  `,
  styles: [
    `
      .preview {
        margin: 16px 0 0;
        font-size: 13px;
        color: var(--color-ink-500);
      }
      .preview strong {
        font-family: var(--font-mono);
        color: var(--color-ink-900);
      }
    `,
  ],
})
export class DatetimeSectionComponent {
  private readonly s = inject(SettingsService);
  readonly fmt = inject(FormatService);
  readonly locale = this.s.locale;
  readonly dateFormats = DATE_FORMAT_OPTIONS;
  readonly timeFormats = TIME_FORMAT_OPTIONS;
  readonly now = new Date();

  patch(locale: Partial<LocaleSettings>): void {
    this.s.patch({ locale });
  }
}
