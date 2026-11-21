import { Component, inject, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SiteHeaderComponent } from '../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../shared/components/site-footer/site-footer.component';
import { CustomValidators } from '../../../shared/validators/custom-validators';
import { AccountService } from '../../../core/services/account.service';
import { AuthService } from '../../../core/services/auth.service';

/** Create Account → Login → Upload GIS data → View on map. One form; on
 *  success the user goes straight to sign-in and then to the map. */
@Component({
  selector: 'app-register',
  standalone: true,
  imports: [ReactiveFormsModule, RouterLink, ButtonModule, InputTextModule, PasswordModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './register.component.html',
  styleUrl: './register.component.scss'
})
export class RegisterComponent {
  private readonly fb = inject(FormBuilder);
  private readonly account = inject(AccountService);
  private readonly auth = inject(AuthService);

  readonly submitting = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly form = this.fb.nonNullable.group(
    {
      fullName: ['', [Validators.required, Validators.minLength(2)]],
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, CustomValidators.passwordStrength()]],
      confirmPassword: ['', [Validators.required]]
    },
    { validators: CustomValidators.passwordsMatch('password', 'confirmPassword') }
  );

  get f() {
    return this.form.controls;
  }

  get passwordMismatch(): boolean {
    return !!this.form.errors?.['passwordMismatch'] && this.f.confirmPassword.touched;
  }

  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { fullName, email, password } = this.form.getRawValue();
    this.submitting.set(true);
    this.errorMessage.set(null);
    this.account.register({ fullName: fullName.trim(), email: email.trim(), password }).subscribe({
      next: () => {
        void this.auth.login({ redirectUri: window.location.origin + '/gis', loginHint: email.trim() });
      },
      error: (error: HttpErrorResponse) => {
        this.submitting.set(false);
        this.errorMessage.set(this.resolveError(error));
      }
    });
  }

  private resolveError(error: HttpErrorResponse): string {
    if (error.status === 409) {
      return 'An account with this email already exists. Try signing in instead.';
    }
    const message = error.error?.message;
    if (error.status === 400 && message) {
      return Array.isArray(message) ? message.join(' ') : String(message);
    }
    if (error.status === 0) {
      return 'Cannot reach the server. Check your connection and try again.';
    }
    return 'Could not create your account. Please try again.';
  }
}
