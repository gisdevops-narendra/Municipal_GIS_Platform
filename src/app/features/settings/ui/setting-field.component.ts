import { Component, input } from '@angular/core';

/**
 * One labelled row inside a Settings section: a name + optional hint on the
 * left, the control (projected) on the right. Collapses to a stacked layout
 * on narrow screens. Purely presentational.
 */
@Component({
  selector: 'app-setting-field',
  standalone: true,
  template: `
    <div class="sf" [class.sf--stack]="stack()">
      <div class="sf__meta">
        <span class="sf__label">{{ label() }}</span>
        @if (hint()) {
          <span class="sf__hint">{{ hint() }}</span>
        }
      </div>
      <div class="sf__control">
        <ng-content />
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .sf {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 24px;
        padding: 16px 0;
        border-bottom: 1px solid var(--color-line);
      }
      :host:last-of-type .sf {
        border-bottom: 0;
      }
      .sf__meta {
        display: flex;
        flex-direction: column;
        gap: 3px;
        max-width: 26rem;
      }
      .sf__label {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--color-ink-900);
      }
      .sf__hint {
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--color-ink-500);
      }
      .sf__control {
        flex: 0 0 auto;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        min-width: 15rem;
        max-width: 22rem;
      }
      .sf--stack,
      .sf--stack .sf__control {
        align-items: stretch;
      }
      .sf--stack {
        flex-direction: column;
        gap: 12px;
      }
      @media (max-width: 720px) {
        .sf {
          flex-direction: column;
          gap: 12px;
        }
        .sf__control {
          align-items: stretch;
          min-width: 0;
          max-width: none;
          width: 100%;
        }
      }
    `,
  ],
})
export class SettingFieldComponent {
  readonly label = input('');
  readonly hint = input('');
  /** Force the stacked (label above control) layout even on wide screens. */
  readonly stack = input(false);
}
