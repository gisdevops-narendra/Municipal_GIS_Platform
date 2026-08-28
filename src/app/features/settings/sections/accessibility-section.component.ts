import { Component, inject } from '@angular/core';
import { SettingsService } from '../../../core/services/settings.service';
import { AccessibilitySettings } from '../../../core/settings/app-settings.model';
import { SettingToggleComponent } from '../ui/setting-toggle.component';

/** Settings → Accessibility. Applied live by `ThemeService` (attributes /
 *  classes on `<html>`; the rules live in `src/styles.scss`). */
@Component({
  selector: 'app-accessibility-section',
  standalone: true,
  imports: [SettingToggleComponent],
  template: `
    <app-setting-toggle
      label="Higher contrast"
      hint="Stronger borders and text contrast for low-vision use."
      [value]="a().highContrast"
      (valueChange)="patch({ highContrast: $event })"
    />
    <app-setting-toggle
      label="Reduce motion"
      hint="Suppresses non-essential animations and map fly-to transitions."
      [value]="a().reduceMotion"
      (valueChange)="patch({ reduceMotion: $event })"
    />
    <app-setting-toggle
      label="Always underline links"
      hint="Underlines in-text links rather than relying on colour alone."
      [value]="a().underlineLinks"
      (valueChange)="patch({ underlineLinks: $event })"
    />
    <app-setting-toggle
      label="Larger click targets"
      hint="Increases the minimum size of buttons, checkboxes and toolbar controls."
      [value]="a().largeTargets"
      (valueChange)="patch({ largeTargets: $event })"
    />
  `,
})
export class AccessibilitySectionComponent {
  private readonly s = inject(SettingsService);
  readonly a = this.s.accessibility;

  patch(accessibility: Partial<AccessibilitySettings>): void {
    this.s.patch({ accessibility });
  }
}
