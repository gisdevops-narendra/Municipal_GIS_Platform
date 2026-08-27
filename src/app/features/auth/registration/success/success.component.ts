import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { SiteHeaderComponent } from '../../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../../shared/components/site-footer/site-footer.component';
import { RegistrationStateService } from '../../../../core/services/registration-state.service';

interface NextStep {
  label: string;
}

@Component({
  selector: 'app-success',
  standalone: true,
  imports: [ButtonModule, SiteHeaderComponent, SiteFooterComponent],
  templateUrl: './success.component.html',
  styleUrl: './success.component.scss'
})
export class SuccessComponent {
  private readonly state = inject(RegistrationStateService);
  private readonly router = inject(Router);

  readonly municipality = this.state.municipality;
  readonly owner = this.state.owner;

  readonly nextSteps: NextStep[] = [
    { label: 'Configure municipality' },
    { label: 'Create departments' },
    { label: 'Invite users' },
    { label: 'Configure GIS workspace' },
    { label: 'Upload GIS data' }
  ];

  onGoToLogin(): void {
    // Registration state is cleared once the flow is fully handed off to
    // login, so a later visit to /register starts a clean wizard.
    this.state.reset();
    this.router.navigateByUrl('/login');
  }
}
