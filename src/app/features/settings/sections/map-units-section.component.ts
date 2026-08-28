import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { MapSettings } from '../../../core/settings/app-settings.model';
import { FormatService } from '../../../core/services/format.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { MAP_UNITS_OPTIONS } from '../settings.data';

/** Settings → Map Units. Used by the Measurement Tool, buffer distances and
 *  every length/area readout (`FormatService`). */
@Component({
  selector: 'app-map-units-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field label="Measurement units" hint="Applies to distances, areas and the scale bar.">
      <p-select
        [options]="unitOptions"
        optionLabel="label"
        optionValue="value"
        [ngModel]="map().units"
        (ngModelChange)="patch({ units: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <p class="preview">
      Preview: <strong>{{ fmt.length(1450) }}</strong> ·
      <strong>{{ fmt.area(52000) }}</strong>
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
export class MapUnitsSectionComponent {
  private readonly s = inject(SettingsService);
  readonly fmt = inject(FormatService);
  readonly map = this.s.map;
  readonly unitOptions = MAP_UNITS_OPTIONS;

  patch(map: Partial<MapSettings>): void {
    this.s.patch({ map });
  }
}
