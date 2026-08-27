import { Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { HttpErrorResponse } from '@angular/common/http';
import { ButtonModule } from 'primeng/button';
import { MessageModule } from 'primeng/message';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { RegistrationProgressComponent } from '../../../../shared/components/registration-progress/registration-progress.component';
import { RegistrationStateService } from '../../../../core/services/registration-state.service';
import { MunicipalityService } from '../../../../core/services/municipality.service';
import { MUNICIPALITY_TYPES } from '../../../../core/data/municipality-types.data';
import { REGISTRATION_STEPS } from '../registration-steps';

@Component({
  selector: 'app-review',
  standalone: true,
  imports: [ButtonModule, MessageModule, SiteHeaderComponent, SiteFooterComponent, RegistrationProgressComponent],
  templateUrl: './review.component.html',
  styleUrl: './review.component.scss'
})
export class ReviewComponent {
  private readonly router = inject(Router);
  private readonly state = inject(RegistrationStateService);
  private readonly municipalityService = inject(MunicipalityService);

  readonly steps = REGISTRATION_STEPS;
  readonly municipality = this.state.municipality;
  readonly owner = this.state.owner;
  submitting = false;

  readonly errorMessage = signal<string | null>(null);

  readonly municipalityTypeLabel = computed(() => {
    const code = this.municipality().type;
    return MUNICIPALITY_TYPES.find((t) => t.code === code)?.label ?? '—';
  });

  onBack(): void {
    this.router.navigateByUrl('/register/owner');
  }

  onCreateMunicipality(): void {
    const owner = this.owner();
    if (!owner) {
      this.router.navigateByUrl('/register/owner');
      return;
    }

    const municipality = this.municipality();
    this.submitting = true;
    this.errorMessage.set(null);

    this.municipalityService
      .register({
        municipality: {
          name: municipality.name,
          type: municipality.type ?? '',
          state: municipality.state,
          district: municipality.district,
          city: municipality.cityOrTown,
          officialEmail: municipality.officialEmail,
          contactNumber: municipality.contactNumber
        },
        owner: {
          fullName: owner.fullName,
          email: owner.officialEmail,
          mobileNumber: owner.mobileNumber,
          password: owner.password
        }
      })
      .subscribe({
        next: () => {
          this.submitting = false;
          this.state.submitRegistration();
          this.router.navigateByUrl('/register/success');
        },
        error: (error: HttpErrorResponse) => {
          this.submitting = false;
          this.errorMessage.set(this.resolveErrorMessage(error));
        }
      });
  }

  private resolveErrorMessage(error: HttpErrorResponse): string {
    if (error.status === 409) {
      return (
        error.error?.message ??
        'A municipality or user with these details is already registered. Try signing in instead.'
      );
    }
    if (error.status === 400) {
      return 'Some details could not be validated. Please go back and check each step.';
    }
    return 'Something went wrong while creating your municipality. Please try again.';
  }
}
