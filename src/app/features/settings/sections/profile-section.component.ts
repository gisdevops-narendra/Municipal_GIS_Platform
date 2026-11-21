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

        <app-setting-field label="Email" hint="Used to sign in. It can't be changed here.">
          <span class="value">{{ me()!.email }}</span>
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
