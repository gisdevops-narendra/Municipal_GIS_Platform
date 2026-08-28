import { Component, input, model } from '@angular/core';
import { CheckboxModule } from 'primeng/checkbox';
import { FormsModule } from '@angular/forms';

/**
 * A binary on/off row: label + hint on the left, a checkbox on the right.
 * Two-way bindable via `[(value)]`.
 */
@Component({
  selector: 'app-setting-toggle',
  standalone: true,
  imports: [CheckboxModule, FormsModule],
  template: `
    <label class="st">
      <span class="st__meta">
        <span class="st__label">{{ label() }}</span>
        @if (hint()) {
          <span class="st__hint">{{ hint() }}</span>
        }
      </span>
      <p-checkbox
        [binary]="true"
        [ngModel]="value()"
        (ngModelChange)="value.set($event)"
        [inputId]="label()"
      />
    </label>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .st {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        padding: 14px 0;
        border-bottom: 1px solid var(--color-line);
        cursor: pointer;
      }
      :host:last-of-type .st {
        border-bottom: 0;
      }
      .st__meta {
        display: flex;
        flex-direction: column;
        gap: 3px;
      }
      .st__label {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--color-ink-900);
      }
      .st__hint {
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--color-ink-500);
      }
    `,
  ],
})
export class SettingToggleComponent {
  readonly label = input('');
  readonly hint = input('');
  readonly value = model(false);
}
