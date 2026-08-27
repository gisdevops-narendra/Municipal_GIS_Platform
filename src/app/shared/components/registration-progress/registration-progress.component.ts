import { Component, Input } from '@angular/core';

export interface RegistrationStep {
  label: string;
}

@Component({
  selector: 'app-registration-progress',
  standalone: true,
  templateUrl: './registration-progress.component.html',
  styleUrl: './registration-progress.component.scss'
})
export class RegistrationProgressComponent {
  @Input({ required: true }) steps: RegistrationStep[] = [];
  /** 1-based index of the current step. */
  @Input({ required: true }) current = 1;

  get total(): number {
    return this.steps.length;
  }
}
