import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { CurrentUserService } from '../../../core/services/current-user.service';
import { NotificationService } from '../../../core/services/notification.service';
import { CurrentUser } from '../../../core/models/current-user.model';
import { SettingFieldComponent } from '../ui/setting-field.component';
import { AuthService } from '../../../core/services/auth.service';

/**
 * Settings → Profile & Account. Editable: full name and mobile number
 * (`PATCH /api/me`). Email, role, department and municipality are shown
 * read-only — they are administrative and changed elsewhere.
 */
@Component({
  selector: 'app-profile-section',
  standalone: true,
  imports: [ReactiveFormsModule, ButtonModule, InputTextModule, MessageModule, SettingFieldComponent],
  template: `
    @if (loadError()) {
      <p-message severity="error" [text]="loadError()!" />
    } @else if (!me()) {
      <p class="muted">Loading your profile…</p>
    } @else {
      <form [formGroup]="form" (ngSubmit)="save()">
        <app-setting-field label="Full name" hint="Shown in the app and on the maps you print.">
          <input pInputText class="input" formControlName="fullName" autocomplete="name" />
          @if (form.controls.fullName.touched && form.controls.fullName.invalid) {
            <span class="field__error">Enter your name (2–150 characters).</span>
          }
        </app-setting-field>

        <app-setting-field label="Mobile number" hint="Optional.">
          <input pInputText class="input" formControlName="mobileNumber" autocomplete="tel" placeholder="Not set" />
          @if (form.controls.mobileNumber.touched && form.controls.mobileNumber.invalid) {
            <span class="field__error">Enter a valid phone number (7–20 digits).</span>
          }
        </app-setting-field>

        <app-setting-field label="Email" hint="Used to sign in. A new address must be verified.">
          <span class="value">{{ me()!.email }}</span>
          @if (!changingEmail()) {
            <button pButton type="button" size="small" [text]="true" label="Change" (click)="changingEmail.set(true)"></button>
          }
        </app-setting-field>

        @if (changingEmail()) {
          <div class="email-change">
            <label class="ec-field">
              <span class="ec-label">New email</span>
              <input pInputText class="input" type="email" [value]="newEmail()" (input)="newEmail.set($any($event.target).value)" autocomplete="email" />
            </label>
            <label class="ec-field">
              <span class="ec-label">Current password</span>
              <input pInputText class="input" type="password" [value]="emailPassword()" (input)="emailPassword.set($any($event.target).value)" autocomplete="current-password" />
            </label>
            <p class="ec-hint">You'll be signed out. Sign in with the new email and confirm it with the link we send there.</p>
            @if (emailError(); as message) {
              <p class="field__error" role="alert">{{ message }}</p>
            }
            <div class="actions actions--tight">
              <button pButton type="button" size="small" [text]="true" label="Cancel" [disabled]="emailBusy()" (click)="cancelEmail()"></button>
              <button pButton type="button" size="small" label="Change email" [loading]="emailBusy()"
                      [disabled]="!newEmail() || !emailPassword() || emailBusy()" (click)="changeEmail()"></button>
            </div>
          </div>
        }

        <app-setting-field label="Password" hint="Change the password you sign in with.">
          <button pButton type="button" size="small" [outlined]="true" icon="pi pi-key" label="Change password" (click)="changePassword()"></button>
        </app-setting-field>

        <div class="actions">
          <button pButton type="submit" label="Save changes" size="small" [disabled]="form.pristine || saving()"></button>
        </div>
      </form>
    }
  `,
  styles: [
    `
      .muted {
        font-size: 13px;
        color: var(--color-ink-500);
      }
      .input {
        width: 100%;
        height: 34px;
        font-size: 13.5px;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        padding-top: 16px;
      }
      .actions--tight {
        gap: 8px;
        padding-top: 4px;
      }
      .email-change {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin: 0 0 6px;
        padding: 14px;
        border: 1px solid var(--color-line);
        border-radius: 10px;
        background: var(--color-surface-alt);
      }
      .ec-field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .ec-label {
        font-size: 12.5px;
        font-weight: 600;
        color: var(--color-ink-700);
      }
      .ec-hint {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--color-ink-500);
      }
      .field__error {
        font-size: 12px;
        color: var(--p-red-500, #dc2626);
      }
      .value {
        padding-top: 2px;
        font-size: 13.5px;
        color: var(--color-ink-700);
        word-break: break-all;
        text-align: right;
      }
      .form {
        display: flex;
        flex-direction: column;
        gap: 18px;
        max-width: 30rem;
      }
      .field {
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .field__label {
        font-size: 13px;
        font-weight: 600;
      }
      .field input {
        width: 100%;
      }
      .field__error {
        font-size: 12px;
        color: var(--color-error-600);
      }
      .readonly {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px 20px;
        padding: 16px;
        border: 1px solid var(--color-line);
        border-radius: var(--radius-sm);
        background: var(--color-surface-alt);
      }
      .readonly div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .readonly span {
        font-size: 11.5px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--color-ink-500);
      }
      .readonly strong {
        font-size: 13px;
        color: var(--color-ink-900);
      }
      @media (max-width: 560px) {
        .readonly {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class ProfileSectionComponent {
  private readonly users = inject(CurrentUserService);
  private readonly auth = inject(AuthService);

  changePassword(): void {
    void this.auth.changePassword();
  }

  readonly changingEmail = signal(false);
  readonly newEmail = signal('');
  readonly emailPassword = signal('');
  readonly emailBusy = signal(false);
  readonly emailError = signal<string | null>(null);

  cancelEmail(): void {
    this.changingEmail.set(false);
    this.newEmail.set('');
    this.emailPassword.set('');
    this.emailError.set(null);
  }

  changeEmail(): void {
    const email = this.newEmail().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.emailError.set('Enter a valid email address.');
      return;
    }
    this.emailBusy.set(true);
    this.emailError.set(null);
    this.users.changeEmail(email, this.emailPassword()).subscribe({
      next: ({ email: saved }) => {
        this.notify.success(`Email changed to ${saved}. Sign in again and confirm it from your inbox.`);
        setTimeout(() => void this.auth.logout(window.location.origin + '/login'), 1800);
      },
      error: (err: HttpErrorResponse) => {
        this.emailBusy.set(false);
        this.emailError.set(
          err.status === 403
            ? 'That password is not correct.'
            : err.status === 409
              ? 'An account with this email already exists.'
              : (err.error?.message as string) ?? 'Could not change the email. Please try again.',
        );
      },
    });
  }
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(NotificationService);

  readonly me = signal<CurrentUser | null>(null);
  readonly loadError = signal<string | null>(null);
  readonly saving = signal(false);

  readonly form = this.fb.nonNullable.group({
    fullName: ['', [Validators.required, Validators.minLength(2), Validators.maxLength(150)]],
    mobileNumber: ['', [Validators.pattern(/^[0-9+\-\s()]{7,20}$/)]],
  });

  constructor() {
    this.users.getMe().subscribe({
      next: (user) => {
        this.me.set(user);
        this.form.reset({ fullName: user.name, mobileNumber: user.mobileNumber ?? '' });
      },
      error: () => this.loadError.set('Could not load your profile. Try again later.'),
    });
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { fullName, mobileNumber } = this.form.getRawValue();
    this.saving.set(true);
    this.users.updateMe({ fullName: fullName.trim(), mobileNumber: mobileNumber.trim() }).subscribe({
      next: (user) => {
        this.saving.set(false);
        this.me.set(user);
        this.form.reset({ fullName: user.name, mobileNumber: user.mobileNumber ?? '' });
        this.notify.success('Your profile has been updated.', 'Saved');
      },
      error: (error: HttpErrorResponse) => {
        this.saving.set(false);
        const message = error.error?.message;
        this.notify.error(
          Array.isArray(message) ? message.join('. ') : message ?? 'Could not save your profile. Try again.'
        );
      },
    });
  }
}
