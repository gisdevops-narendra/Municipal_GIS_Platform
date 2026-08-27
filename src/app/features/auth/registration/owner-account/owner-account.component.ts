import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { PasswordModule } from 'primeng/password';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { RegistrationProgressComponent } from '../../../../shared/components/registration-progress/registration-progress.component';
import { CustomValidators } from '../../../../shared/validators/custom-validators';
import { RegistrationStateService } from '../../../../core/services/registration-state.service';
import { REGISTRATION_STEPS } from '../registration-steps';

@Component({
  selector: 'app-owner-account',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    ButtonModule,
    InputTextModule,
    PasswordModule,
    SiteHeaderComponent,
    SiteFooterComponent,
    RegistrationProgressComponent
  ],
  templateUrl: './owner-account.component.html',
  styleUrl: './owner-account.component.scss'
})
export class OwnerAccountComponent {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly state = inject(RegistrationStateService);

  readonly steps = REGISTRATION_STEPS;

  readonly form = this.fb.nonNullable.group(
    {
      fullName: ['', [Validators.required, Validators.minLength(2)]],
      officialEmail: ['', [Validators.required, Validators.email]],
      mobileNumber: ['', [Validators.required, CustomValidators.indianMobile()]],
      password: ['', [Validators.required, CustomValidators.passwordStrength()]],
      confirmPassword: ['', [Validators.required]]
    },
    { validators: CustomValidators.passwordsMatch('password', 'confirmPassword') }
  );

  constructor() {
    // If step 1 hasn't been completed, send the user back — there's no
    // owner account to create without a municipality to attach it to.
    if (!this.state.isStep1Complete()) {
      this.router.navigateByUrl('/register/municipality');
      return;
    }
    const existing = this.state.owner();
    if (existing) {
      this.form.patchValue(existing);
    }
  }

  get f() {
    return this.form.controls;
  }

  get passwordMismatch(): boolean {
    return !!this.form.errors?.['passwordMismatch'] && this.f.confirmPassword.touched;
  }

  onBack(): void {
    this.router.navigateByUrl('/register/municipality');
  }

  onContinue(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.state.setOwnerInfo({ ...value });
    this.router.navigateByUrl('/register/review');
  }
}
