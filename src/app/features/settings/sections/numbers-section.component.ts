import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { LocaleSettings } from '../../../core/settings/app-settings.model';
import { FormatService } from '../../../core/services/format.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { NUMBER_FORMAT_OPTIONS } from '../settings.data';

/** Settings → Number Format. Drives grouping / decimal style for every
 *  numeric readout that goes through `FormatService`. */
@Component({
  selector: 'app-numbers-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field
      label="Number format"
      hint="Grouping and decimal separators for measurements, coordinates and table values."
    >
      <p-select
        [options]="numberFormats"
        optionLabel="label"
        optionValue="value"
        [ngModel]="locale().numberFormat"
        (ngModelChange)="patch({ numberFormat: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <p class="preview">
      Preview: <strong>{{ fmt.number(1234567.89, 2) }}</strong> ·
      <strong>{{ fmt.number(42) }}</strong>
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
export class NumbersSectionComponent {
  private readonly s = inject(SettingsService);
  readonly fmt = inject(FormatService);
  readonly locale = this.s.locale;
  readonly numberFormats = NUMBER_FORMAT_OPTIONS;

  patch(locale: Partial<LocaleSettings>): void {
    this.s.patch({ locale });
  }
}
