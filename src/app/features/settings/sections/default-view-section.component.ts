import { Component, computed, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { InputNumberModule } from 'primeng/inputnumber';
import { ButtonModule } from 'primeng/button';
import { SettingsService } from '../../../core/services/settings.service';
import { DefaultMapView } from '../../../core/settings/app-settings.model';
import { NotificationService } from '../../../core/services/notification.service';
import { SettingFieldComponent } from '../ui/setting-field.component';

/** Settings → Default Map Extent. `null` (the default) means the workspace
 *  frames automatically from the layers' combined bounds. */
@Component({
  selector: 'app-default-view-section',
  standalone: true,
  imports: [FormsModule, InputNumberModule, ButtonModule, SettingFieldComponent],
  template: `
    <app-setting-field
      label="Startup extent"
      hint="Leave cleared to let the map frame itself from your layers. Set a point + zoom to always open in the same place."
      [stack]="true"
    >
      <div class="grid">
        <label class="field">
          <span>Longitude</span>
          <p-inputnumber
            [ngModel]="view().lon"
            (ngModelChange)="patch({ lon: $event })"
            [minFractionDigits]="1"
            [maxFractionDigits]="6"
            [min]="-180"
            [max]="180"
          />
        </label>
        <label class="field">
          <span>Latitude</span>
          <p-inputnumber
            [ngModel]="view().lat"
            (ngModelChange)="patch({ lat: $event })"
            [minFractionDigits]="1"
            [maxFractionDigits]="6"
            [min]="-90"
            [max]="90"
          />
        </label>
        <label class="field">
          <span>Zoom</span>
          <p-inputnumber
            [ngModel]="view().zoom"
            (ngModelChange)="patch({ zoom: $event })"
            [min]="0"
            [max]="24"
          />
        </label>
      </div>
      <div class="actions">
        <button
          pButton
          type="button"
          class="p-button-text p-button-sm"
          label="Clear — frame automatically"
          [disabled]="!s.map().defaultView"
          (click)="clear()"
        ></button>
      </div>
    </app-setting-field>
  `,
  styles: [
    `
      .grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(7rem, 1fr));
        gap: 12px;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12.5px;
        color: var(--color-ink-500);
      }
      .actions {
        margin-top: 10px;
      }
      @media (max-width: 560px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class DefaultViewSectionComponent {
  readonly s = inject(SettingsService);
  private readonly notify = inject(NotificationService);

  /** A concrete view for the inputs — falls back to a neutral India-centred
   *  point while none is saved. */
  readonly view = computed<DefaultMapView>(
    () => this.s.map().defaultView ?? { lon: 78.9629, lat: 22.5937, zoom: 5 },
  );

  patch(part: Partial<DefaultMapView>): void {
    this.s.patch({ map: { defaultView: { ...this.view(), ...part } } });
  }

  clear(): void {
    this.s.patch({ map: { defaultView: null } });
    this.notify.info('The map will frame automatically from your layers.', 'Startup extent cleared');
  }
}
