import { Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { SelectModule } from 'primeng/select';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { RegistrationProgressComponent } from '../../../../shared/components/registration-progress/registration-progress.component';
import { CustomValidators } from '../../../../shared/validators/custom-validators';
import { RegistrationStateService } from '../../../../core/services/registration-state.service';
import { MUNICIPALITY_TYPES } from '../../../../core/data/municipality-types.data';
import { INDIAN_STATES } from '../../../../core/data/indian-states.data';
import { REGISTRATION_STEPS } from '../registration-steps';

@Component({
  selector: 'app-municipality-info',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonModule,
    InputTextModule,
    SelectModule,
    SiteHeaderComponent,
    SiteFooterComponent,
    RegistrationProgressComponent
  ],
  templateUrl: './municipality-info.component.html',
  styleUrl: './municipality-info.component.scss'
})
export class MunicipalityInfoComponent {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly state = inject(RegistrationStateService);

  readonly steps = REGISTRATION_STEPS;
  readonly municipalityTypes = MUNICIPALITY_TYPES;
  readonly states = INDIAN_STATES;

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, CustomValidators.municipalityName()]],
    type: [null as string | null, [Validators.required]],
    state: [null as string | null, [Validators.required]],
    district: ['', [Validators.required, Validators.minLength(2)]],
    cityOrTown: ['', [Validators.required, Validators.minLength(2)]],
    officialEmail: ['', [Validators.required, Validators.email]],
    contactNumber: ['', [Validators.required, CustomValidators.indianMobile()]]
  });

  constructor() {
    const existing = this.state.municipality();
    if (existing.name) {
      this.form.patchValue(existing as any);
    }
  }

  get f() {
    return this.form.controls;
  }

  onContinue(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const value = this.form.getRawValue();
    this.state.setMunicipalityInfo({
      name: value.name.trim(),
      type: value.type as any,
      state: value.state ?? '',
      district: value.district.trim(),
      cityOrTown: value.cityOrTown.trim(),
      officialEmail: value.officialEmail.trim(),
      contactNumber: value.contactNumber.trim()
    });
    this.router.navigateByUrl('/register/owner');
  }
}
