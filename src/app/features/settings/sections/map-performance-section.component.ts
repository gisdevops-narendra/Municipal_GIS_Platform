import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { SliderModule } from 'primeng/slider';
import { SettingsService } from '../../../core/services/settings.service';
import { MapPerformanceSettings } from '../../../core/settings/app-settings.model';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { SettingToggleComponent } from '../ui/setting-toggle.component';
import { RENDER_QUALITY_OPTIONS } from '../settings.data';

/** Settings → Map Performance. Read by the GIS workspace when it builds the
 *  map and issues GetFeatureInfo requests. */
@Component({
  selector: 'app-map-performance-section',
  standalone: true,
  imports: [
    FormsModule,
    SelectModule,
    SliderModule,
    SettingFieldComponent,
    SettingToggleComponent,
  ],
  template: `
    <app-setting-field
      label="Render quality"
      hint="High renders tiles at the screen's true pixel density — sharper, but more data and slower on weak connections."
    >
      <p-select
        [options]="qualityOptions"
        optionLabel="label"
        optionValue="value"
        [ngModel]="perf().renderQuality"
        (ngModelChange)="patch({ renderQuality: $event })"
        appendTo="body"
      />
    </app-setting-field>

    <app-setting-toggle
      label="Animate the map"
      hint="Smooth pan / zoom and fly-to transitions. Turn off for a snappier feel or with motion sensitivity."
      [value]="perf().animateMap"
      (valueChange)="patch({ animateMap: $event })"
    />

    <app-setting-field
      label="Feature info limit"
      [hint]="'Maximum features returned per layer when you click the map — currently ' + perf().featureInfoLimit"
      [stack]="true"
    >
      <p-slider
        [min]="1"
        [max]="25"
        [step]="1"
        [ngModel]="perf().featureInfoLimit"
        (ngModelChange)="patch({ featureInfoLimit: $event })"
      />
    </app-setting-field>
  `,
})
export class MapPerformanceSectionComponent {
  private readonly s = inject(SettingsService);
  readonly qualityOptions = RENDER_QUALITY_OPTIONS;
  readonly perf = () => this.s.map().performance;

  patch(performance: Partial<MapPerformanceSettings>): void {
    this.s.patch({ map: { performance } });
  }
}
