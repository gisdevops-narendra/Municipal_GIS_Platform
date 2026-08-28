import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { MapSettings } from '../../../core/settings/app-settings.model';
import { FormatService } from '../../../core/services/format.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { COORDINATE_FORMAT_OPTIONS } from '../settings.data';

/** Settings → Coordinate Format. Used by the map cursor readout and feature
 *  info (`FormatService.coordinate`). */
@Component({
  selector: 'app-coordinates-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field label="Coordinate display" hint="How latitude / longitude pairs are shown across the map.">
      <p-select
        [options]="formatOptions"
        optionLabel="label"
        optionValue="value"
        [ngModel]="map().coordinateFormat"
        (ngModelChange)="patch({ coordinateFormat: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <p class="preview">
      Preview: <strong>{{ fmt.coordinate(72.5814, 23.0225) }}</strong>
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
export class CoordinatesSectionComponent {
  private readonly s = inject(SettingsService);
  readonly fmt = inject(FormatService);
  readonly map = this.s.map;
  readonly formatOptions = COORDINATE_FORMAT_OPTIONS;

  patch(map: Partial<MapSettings>): void {
    this.s.patch({ map });
  }
}
