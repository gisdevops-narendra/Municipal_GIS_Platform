import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { CheckboxModule } from 'primeng/checkbox';
import { PasswordModule } from 'primeng/password';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { AuthService } from '../../../core/services/auth.service';
import { NotificationService } from '../../../core/services/notification.service';
import { SettingsDialogService } from '../../../core/services/settings-dialog.service';

/** Settings → Data & privacy → Delete account. Two steps: a plain
 *  "Delete account" button, then a confirm panel (password + "I
 *  understand") so it can't happen by accident. */
@Component({
  selector: 'app-delete-account-section',
  standalone: true,
  imports: [FormsModule, ButtonModule, CheckboxModule, PasswordModule],
  template: `
    <div class="row">
      <div class="meta">
        <span class="label">Delete account</span>
        <span class="hint">
          Permanently deletes your account, every layer and upload, and your map workspace.
          This can't be undone.
        </span>
      </div>
      @if (!confirming()) {
        <button pButton type="button" size="small" severity="danger" [outlined]="true" label="Delete account" (click)="confirming.set(true)"></button>
      }
    </div>

    @if (confirming()) {
      <form class="confirm" (ngSubmit)="remove()">
        <label class="field">
          <span class="field__label">Enter your password to confirm</span>
          <p-password [(ngModel)]="password" name="password" [feedback]="false" [toggleMask]="true" inputStyleClass="w-full" styleClass="w-full" autocomplete="current-password" />
        </label>
        <label class="check">
          <p-checkbox [(ngModel)]="understood" name="understood" [binary]="true" inputId="del-understood" />
          <span>I understand my account and all of my GIS data will be deleted permanently.</span>
        </label>
        @if (error(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button pButton type="button" size="small" [text]="true" label="Cancel" [disabled]="busy()" (click)="cancel()"></button>
          <button pButton type="submit" size="small" severity="danger" icon="pi pi-trash" label="Delete permanently"
                  [loading]="busy()" [disabled]="!password || !understood || busy()"></button>
        </div>
      </form>
    }
  `,
  styles: [
    `
      .row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 20px;
        padding: 14px 0;
      }
      .meta {
        display: flex;
        flex-direction: column;
        gap: 3px;
        max-width: 26rem;
      }
      .label {
        font-size: 13.5px;
        font-weight: 600;
        color: var(--p-red-600, #dc2626);
      }
      .hint {
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--color-ink-500);
      }
      .confirm {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 14px;
        border: 1px solid color-mix(in srgb, var(--p-red-500, #ef4444) 45%, transparent);
        border-radius: 10px;
        background: color-mix(in srgb, var(--p-red-500, #ef4444) 6%, transparent);
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .field__label {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--color-ink-700);
      }
      .check {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        font-size: 12.5px;
        line-height: 1.5;
        color: var(--color-ink-700);
        cursor: pointer;
      }
      .error {
        margin: 0;
        font-size: 12.5px;
        color: var(--p-red-600, #dc2626);
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      @media (max-width: 640px) {
        .row {
          flex-direction: column;
          gap: 10px;
        }
      }
    `,
  ],
})
export class DeleteAccountSectionComponent {
  private readonly users = inject(CurrentUserService);
  private readonly auth = inject(AuthService);
  private readonly notify = inject(NotificationService);
  private readonly dialog = inject(SettingsDialogService);

  readonly confirming = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  password = '';
  understood = false;

  cancel(): void {
    this.confirming.set(false);
    this.password = '';
    this.understood = false;
    this.error.set(null);
  }

  remove(): void {
    if (!this.password || !this.understood) return;
    this.busy.set(true);
    this.error.set(null);
    this.users.deleteAccount(this.password).subscribe({
      next: () => {
        this.dialog.close();
        this.notify.success('Your account has been deleted.');
        void this.auth.logout(window.location.origin + '/');
      },
      error: (err: HttpErrorResponse) => {
        this.busy.set(false);
        this.error.set(
          err.status === 403
            ? 'That password is not correct.'
            : (err.error?.message as string) ?? 'Could not delete the account. Please try again.',
        );
      },
    });
  }
}
