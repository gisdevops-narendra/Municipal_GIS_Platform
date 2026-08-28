import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { SettingsService } from '../../../core/services/settings.service';
import { AppearanceSettings } from '../../../core/settings/app-settings.model';
import { COLOR_THEMES } from '../../../core/settings/color-themes';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { DENSITY_OPTIONS, THEME_MODE_OPTIONS } from '../settings.data';

/** Settings → Theme & Colour. Every change is applied live by
 *  `ThemeService` the moment it lands in `SettingsService`. */
@Component({
  selector: 'app-appearance-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SliderModule, SettingFieldComponent],
  template: `
    <app-setting-field label="Appearance" hint="Light, dark, or follow your operating system.">
      <p-select
        [options]="themeModes"
        optionLabel="label"
        optionValue="value"
        [ngModel]="s.appearance().theme"
        (ngModelChange)="patch({ theme: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-field
      label="Colour theme"
      hint="Retunes the primary accent across the app and the map controls."
      [stack]="true"
    >
      <div class="swatches">
        @for (t of colorThemes; track t.id) {
          <button
            type="button"
            class="swatch"
            [class.swatch--active]="s.appearance().colorTheme === t.id"
            (click)="patch({ colorTheme: t.id })"
          >
            <span class="swatch__chip" [style.background]="t.swatch"></span>
            <span class="swatch__label">{{ t.label }}</span>
          </button>
        }
      </div>
    </app-setting-field>

    <app-setting-field label="Density" hint="Compact tightens padding and row heights throughout.">
      <p-select
        [options]="densities"
        optionLabel="label"
        optionValue="value"
        [ngModel]="s.appearance().density"
        (ngModelChange)="patch({ density: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-field
      label="Text size"
      [hint]="'Scale all text — currently ' + percent(s.appearance().fontScale)"
      [stack]="true"
    >
      <p-slider
        [min]="0.85"
        [max]="1.3"
        [step]="0.05"
        [ngModel]="s.appearance().fontScale"
        (ngModelChange)="patch({ fontScale: $event })"
      />
    </app-setting-field>
  `,
  styles: [
    `
      .swatches {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
        gap: 8px;
      }
      .swatch {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border: 1px solid var(--color-line-strong);
        border-radius: var(--radius-sm);
        background: var(--color-surface);
        cursor: pointer;
        font: inherit;
        color: var(--color-ink-700);
        text-align: left;
      }
      .swatch--active {
        border-color: var(--color-primary-500);
        box-shadow: 0 0 0 2px var(--color-primary-100);
        color: var(--color-ink-900);
      }
      .swatch__chip {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        flex: 0 0 auto;
        border: 1px solid rgba(0, 0, 0, 0.15);
      }
      .swatch__label {
        font-size: 12.5px;
      }
    `,
  ],
})
export class AppearanceSectionComponent {
  readonly s = inject(SettingsService);
  readonly themeModes = THEME_MODE_OPTIONS;
  readonly densities = DENSITY_OPTIONS;
  readonly colorThemes = COLOR_THEMES;

  patch(appearance: Partial<AppearanceSettings>): void {
    this.s.patch({ appearance });
  }

  percent(scale: number): string {
    return `${Math.round(scale * 100)}%`;
  }
}
