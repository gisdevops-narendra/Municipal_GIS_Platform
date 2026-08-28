import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { LocaleSettings } from '../../../core/settings/app-settings.model';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { FIRST_DAY_OPTIONS, LANGUAGE_OPTIONS } from '../settings.data';

/** Settings → Language. The chosen tag is used for `<html lang>` and as the
 *  default locale for every `Intl.*` readout (see `FormatService`). */
@Component({
  selector: 'app-language-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field
      label="Interface language"
      hint="Also sets the default locale used for dates, times and numbers. Interface text is English for now."
    >
      <p-select
        [options]="languages"
        optionLabel="label"
        optionValue="value"
        [ngModel]="locale().language"
        (ngModelChange)="patch({ language: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-field label="First day of the week" hint="Used by date pickers and calendars.">
      <p-select
        [options]="firstDays"
        optionLabel="label"
        optionValue="value"
        [ngModel]="locale().firstDayOfWeek"
        (ngModelChange)="patch({ firstDayOfWeek: $event })"
        appendTo="body"
      />
    </app-setting-field>
  `,
})
export class LanguageSectionComponent {
  private readonly s = inject(SettingsService);
  readonly locale = this.s.locale;
  readonly languages = LANGUAGE_OPTIONS;
  readonly firstDays = FIRST_DAY_OPTIONS;

  patch(locale: Partial<LocaleSettings>): void {
    this.s.patch({ locale });
  }
}
