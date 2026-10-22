import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SelectModule } from 'primeng/select';
import { CheckboxModule } from 'primeng/checkbox';
import { ButtonModule } from 'primeng/button';
import { SettingsService } from '../../../core/services/settings.service';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { GisLayersService } from '../../../core/services/gis-layers.service';
import { NotificationService } from '../../../core/services/notification.service';
import { GisLayer } from '../../../core/models/gis-layer.model';
import { AssistantSettings } from '../../../core/settings/app-settings.model';
import { GisAiService } from '../../gis/services/gis-ai.service';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { SettingToggleComponent } from '../ui/setting-toggle.component';
import {
  ASSISTANT_ANSWER_STYLE_OPTIONS,
  ASSISTANT_AREA_UNIT_OPTIONS,
  ASSISTANT_DISTANCE_UNIT_OPTIONS,
  ASSISTANT_LANGUAGE_OPTIONS,
  ASSISTANT_LAYER_SCOPE_OPTIONS,
  ASSISTANT_NEAR_OPTIONS,
  ASSISTANT_PANEL_MODE_OPTIONS,
} from '../settings.data';

/** Settings → AI Assistant. Read by the chat panel (`AiChatComponent`), the
 *  map highlight (`MapService`) and the workspace dock. The Owner can also
 *  store these as the municipality's defaults. */
@Component({
  selector: 'app-assistant-section',
  standalone: true,
  imports: [FormsModule, SelectModule, CheckboxModule, ButtonModule, SettingFieldComponent, SettingToggleComponent],
  template: `
    <h3 class="group">Answers</h3>
    <app-setting-field label="Answer style" hint="Detailed answers open “How this was interpreted”, with the query that ran.">
      <p-select [options]="answerStyles" optionLabel="label" optionValue="value" [ngModel]="a().answerStyle" (ngModelChange)="patch({ answerStyle: $event })" appendTo="body" />
    </app-setting-field>
    <app-setting-field label="Summary language" hint="Language of the AI-worded summaries. Numbers and layer names stay as they are.">
      <p-select [options]="languages" optionLabel="label" optionValue="value" [ngModel]="a().language" (ngModelChange)="patch({ language: $event })" appendTo="body" />
    </app-setting-field>
    <app-setting-field label="Distance unit">
      <p-select [options]="distanceUnits" optionLabel="label" optionValue="value" [ngModel]="a().distanceUnit" (ngModelChange)="patch({ distanceUnit: $event })" appendTo="body" />
    </app-setting-field>
    <app-setting-field label="Area unit">
      <p-select [options]="areaUnits" optionLabel="label" optionValue="value" [ngModel]="a().areaUnit" (ngModelChange)="patch({ areaUnit: $event })" appendTo="body" />
    </app-setting-field>
    <app-setting-field label="What “near” means" hint="Used when a question says “near” without a distance.">
      <p-select [options]="nearOptions" optionLabel="label" optionValue="value" [ngModel]="a().nearMeters" (ngModelChange)="patch({ nearMeters: $event })" appendTo="body" />
    </app-setting-field>
    <app-setting-toggle
      label="AI-worded summaries"
      hint="A friendlier sentence written by the local AI model from the computed numbers. Every number is checked."
      [value]="a().aiSummaries"
      (valueChange)="patch({ aiSummaries: $event })"
    />
    <app-setting-toggle
      label="Instant answers only"
      hint="Never call the AI model. Faster and lighter, but only simple questions are understood."
      [value]="a().instantOnly"
      (valueChange)="patch({ instantOnly: $event })"
    />

    <h3 class="group">What it searches</h3>
    <app-setting-field label="Layers" hint="Which layers the assistant may answer from.">
      <p-select [options]="layerScopes" optionLabel="label" optionValue="value" [ngModel]="a().layerScope" (ngModelChange)="patch({ layerScope: $event })" appendTo="body" />
    </app-setting-field>
    @if (a().layerScope === 'custom') {
      <div class="layers">
        @if (layersLoading()) {
          <p class="muted">Loading layers…</p>
        } @else if (layers().length === 0) {
          <p class="muted">This municipality has no active GIS layers yet.</p>
        } @else {
          <div class="layers__bar">
            <span class="muted">{{ a().layerIds.length }} of {{ layers().length }} chosen</span>
            <button pButton type="button" class="p-button-text p-button-sm" label="All" (click)="patch({ layerIds: allLayerIds() })"></button>
            <button pButton type="button" class="p-button-text p-button-sm" label="None" (click)="patch({ layerIds: [] })"></button>
          </div>
          <ul class="layers__list">
            @for (l of layers(); track l.id) {
              <li>
                <label>
                  <p-checkbox [binary]="true" [ngModel]="chosen().has(l.id)" (ngModelChange)="toggleLayer(l.id, $event)" />
                  <span>{{ l.name }}</span>
                </label>
              </li>
            }
          </ul>
          @if (a().layerIds.length === 0) {
            <p class="muted">No layer chosen — the assistant will search all layers.</p>
          }
        }
      </div>
    }

    <h3 class="group">On the map</h3>
    <app-setting-toggle label="Zoom to results" hint="Move the map to what an answer found." [value]="a().autoZoom" (valueChange)="patch({ autoZoom: $event })" />
    <app-setting-toggle
      label="Clear previous results"
      hint="Each answer replaces the last one's highlight. Off: highlights add up until you clear them."
      [value]="a().clearPrevious"
      (valueChange)="patch({ clearPrevious: $event })"
    />
    <app-setting-toggle
      label="Open the Attribute Table"
      hint="Show the matched features in the Attribute Table below the map."
      [value]="a().openTable"
      (valueChange)="patch({ openTable: $event })"
    />
    <app-setting-field label="Highlight colour" hint="Outline and fill of the features an answer found.">
      <span class="colour">
        <input type="color" [value]="a().highlightColor" (change)="patch({ highlightColor: $any($event.target).value })" aria-label="Highlight colour" />
        <code>{{ a().highlightColor }}</code>
      </span>
    </app-setting-field>
    <app-setting-field label="Panel" hint="Where the assistant opens in the GIS workspace.">
      <p-select [options]="panelModes" optionLabel="label" optionValue="value" [ngModel]="a().panelMode" (ngModelChange)="patch({ panelMode: $event })" appendTo="body" />
    </app-setting-field>

    <h3 class="group">Your chats</h3>
    <app-setting-toggle
      label="Save chat history"
      hint="Keep conversations in “Your chats” to reopen later. Off: new chats are not kept. Your municipality's Owner still sees questions in the question log."
      [value]="a().saveHistory"
      (valueChange)="patch({ saveHistory: $event })"
    />
    <app-setting-field label="Delete all my chats" hint="Removes every saved chat of yours. This cannot be undone.">
      <button pButton type="button" class="p-button-outlined p-button-danger p-button-sm" label="Delete all chats" icon="pi pi-trash" [loading]="deleting()" (click)="deleteAll()"></button>
    </app-setting-field>

    <div class="foot">
      <button pButton type="button" class="p-button-text p-button-sm" label="Restore defaults" icon="pi pi-refresh" (click)="s.resetAssistant()"></button>
      @if (isOwner()) {
        <button
          pButton
          type="button"
          class="p-button-sm"
          label="Save as municipality default"
          icon="pi pi-building"
          [loading]="savingDefaults()"
          (click)="saveDefaults()"
        ></button>
      }
    </div>
    @if (isOwner()) {
      <p class="muted foot__hint">
        As the Owner you can make these settings the starting point for everyone in your municipality.
        Users who changed a setting themselves keep their own choice.
      </p>
    }
  `,
  styles: [
    `
      .group {
        margin: 24px 0 0;
        font-family: var(--font-mono);
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--color-ink-500);
      }
      .group:first-child {
        margin-top: 0;
      }
      .muted {
        margin: 0;
        font-size: 12.5px;
        color: var(--color-ink-500);
      }
      .layers {
        padding: 4px 0 16px;
        border-bottom: 1px solid var(--color-line);
      }
      .layers__bar {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 6px;
      }
      .layers__bar .muted {
        flex: 1;
      }
      .layers__list {
        list-style: none;
        margin: 0 0 8px;
        padding: 4px 10px;
        max-height: 260px;
        overflow: auto;
        border: 1px solid var(--color-line);
        border-radius: var(--radius-md);
        columns: 2 220px;
      }
      .layers__list label {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 5px 0;
        font-size: 13px;
        cursor: pointer;
        break-inside: avoid;
      }
      .colour {
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .colour input {
        width: 40px;
        height: 30px;
        padding: 2px;
        border: 1px solid var(--color-line-strong);
        border-radius: var(--radius-sm);
        background: var(--color-surface);
        cursor: pointer;
      }
      .colour code {
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--color-ink-700);
      }
      .foot {
        display: flex;
        justify-content: flex-end;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--color-line);
      }
      .foot__hint {
        margin-top: 8px;
        text-align: right;
        font-size: 12px;
      }
    `,
  ],
})
export class AssistantSectionComponent {
  readonly s = inject(SettingsService);
  private readonly gisLayers = inject(GisLayersService);
  private readonly aiService = inject(GisAiService);
  private readonly notify = inject(NotificationService);

  readonly a = this.s.assistant;
  readonly answerStyles = ASSISTANT_ANSWER_STYLE_OPTIONS;
  readonly languages = ASSISTANT_LANGUAGE_OPTIONS;
  readonly distanceUnits = ASSISTANT_DISTANCE_UNIT_OPTIONS;
  readonly areaUnits = ASSISTANT_AREA_UNIT_OPTIONS;
  readonly nearOptions = ASSISTANT_NEAR_OPTIONS;
  readonly layerScopes = ASSISTANT_LAYER_SCOPE_OPTIONS;
  readonly panelModes = ASSISTANT_PANEL_MODE_OPTIONS;

  readonly layers = signal<GisLayer[]>([]);
  readonly layersLoading = signal(true);
  readonly chosen = computed(() => new Set(this.a().layerIds));
  readonly allLayerIds = computed(() => this.layers().map((l) => l.id));

  readonly isOwner = signal(false);
  readonly savingDefaults = signal(false);
  readonly deleting = signal(false);

  constructor() {
    this.gisLayers.list().subscribe({
      next: (layers) => {
        this.layers.set([...layers].sort((x, y) => x.displayOrder - y.displayOrder));
        this.layersLoading.set(false);
      },
      error: () => this.layersLoading.set(false),
    });
    inject(CurrentUserService)
      .getMe()
      .subscribe({ next: (me) => this.isOwner.set(me.systemRole === 'MUNICIPALITY_OWNER'), error: () => undefined });
  }

  patch(assistant: Partial<AssistantSettings>): void {
    this.s.patch({ assistant });
  }

  toggleLayer(id: string, on: boolean): void {
    const ids = new Set(this.a().layerIds);
    if (on) ids.add(id);
    else ids.delete(id);
    this.patch({ layerIds: [...ids] });
  }

  saveDefaults(): void {
    this.savingDefaults.set(true);
    this.s.saveMunicipalityAssistantDefaults(this.a()).subscribe({
      next: () => {
        this.savingDefaults.set(false);
        this.notify.success('These are now the AI Assistant defaults for your municipality.');
      },
      error: () => {
        this.savingDefaults.set(false);
        this.notify.error('Could not save the municipality defaults.');
      },
    });
  }

  deleteAll(): void {
    this.notify.confirmDelete({
      header: 'Delete all chats?',
      message: 'Every saved AI Assistant chat of yours will be removed. This cannot be undone.',
      confirmLabel: 'Delete all',
      accept: () => {
        this.deleting.set(true);
        this.aiService.deleteAllConversations().subscribe({
          next: ({ deleted }) => {
            this.deleting.set(false);
            this.notify.success(deleted ? `Deleted ${deleted} chat${deleted === 1 ? '' : 's'}.` : 'You had no saved chats.');
          },
          error: () => {
            this.deleting.set(false);
            this.notify.error('Could not delete your chats.');
          },
        });
      },
    });
  }
}
