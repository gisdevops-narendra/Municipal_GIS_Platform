import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SettingsService } from '../../../core/services/settings.service';
import { MapSettings } from '../../../core/settings/app-settings.model';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { BASEMAP_OPTIONS } from '../settings.data';

/** Settings → Default Basemap. The GIS workspace reads this when it first
 *  builds the map; changing it here does not touch an open map. */
@Component({
  selector: 'app-basemap-section',
  standalone: true,
  imports: [FormsModule, SelectModule, SettingFieldComponent],
  template: `
    <app-setting-field
      label="Default basemap"
      hint="The backdrop the Municipal GIS workspace opens with. All options are free, no-key tile services."
    >
      <p-select
        [options]="basemaps"
        optionLabel="label"
        optionValue="value"
        [ngModel]="map().defaultBasemap"
        (ngModelChange)="patch({ defaultBasemap: $event })"
        appendTo="body"
      />
    </app-setting-field>
  `,
})
export class BasemapSectionComponent {
  private readonly s = inject(SettingsService);
  readonly map = this.s.map;
  readonly basemaps = BASEMAP_OPTIONS;

  patch(map: Partial<MapSettings>): void {
    this.s.patch({ map });
  }
}
