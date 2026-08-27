import { Injectable, computed, signal } from '@angular/core';
import { MunicipalityInfo, emptyMunicipalityInfo } from '../models/municipality.model';
import { OwnerAccountInfo, emptyOwnerAccountInfo } from '../models/owner.model';

/**
 * Holds registration wizard state in memory for the lifetime of the
 * registration flow. This is a frontend-only mock — Task 1 does not create
 * any real backend record. A future task will replace `submitRegistration`
 * with an actual API call once the NestJS backend exists.
 */
@Injectable({ providedIn: 'root' })
export class RegistrationStateService {
  private readonly municipalitySignal = signal<MunicipalityInfo>({ ...emptyMunicipalityInfo });
  private readonly ownerSignal = signal<OwnerAccountInfo | null>(null);
  private readonly submittedSignal = signal(false);

  readonly municipality = this.municipalitySignal.asReadonly();
  readonly owner = this.ownerSignal.asReadonly();
  readonly submitted = this.submittedSignal.asReadonly();

  /** Step 1 is considered complete once a municipality name and type exist. */
  readonly isStep1Complete = computed(() => {
    const m = this.municipalitySignal();
    return m.name.trim().length > 0 && !!m.type;
  });

  /** Step 2 is considered complete once an owner record has been captured. */
  readonly isStep2Complete = computed(() => this.ownerSignal() !== null);

  setMunicipalityInfo(info: MunicipalityInfo): void {
    this.municipalitySignal.set(info);
  }

  setOwnerInfo(info: OwnerAccountInfo): void {
    this.ownerSignal.set(info);
  }

  /** Mock "create municipality" call. Always resolves successfully — there
   *  is no backend yet. Marks the flow as submitted so the success screen
   *  can be reached, and so a direct visit to /register/success without
   *  completing the flow can be redirected back to step 1. */
  submitRegistration(): void {
    this.submittedSignal.set(true);
  }

  /** Clears all wizard state, e.g. after returning to the landing page. */
  reset(): void {
    this.municipalitySignal.set({ ...emptyMunicipalityInfo });
    this.ownerSignal.set(null);
    this.submittedSignal.set(false);
  }
}
