import { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** Frontend-only validators. Backend validation will re-validate all of
 *  this server-side later — nothing here is a security boundary. */
export class CustomValidators {
  /** Indian mobile numbers: 10 digits, starting 6-9, optional +91 prefix. */
  static indianMobile(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = (control.value ?? '').toString().trim();
      if (!value) {
        return null;
      }
      const pattern = /^(\+91[\s-]?)?[6-9]\d{9}$/;
      return pattern.test(value) ? null : { invalidMobile: true };
    };
  }

  /** Municipality name: letters, numbers, spaces and a few common
   *  punctuation marks; minimum length to avoid junk entries. */
  static municipalityName(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = (control.value ?? '').toString().trim();
      if (!value) {
        return null;
      }
      if (value.length < 3) {
        return { tooShort: true };
      }
      const pattern = /^[A-Za-z0-9.,'&()\-\s]+$/;
      return pattern.test(value) ? null : { invalidName: true };
    };
  }

  /** Minimum password strength: 8+ chars, at least one letter and one
   *  number. Real password policy enforcement happens in Keycloak. */
  static passwordStrength(): ValidatorFn {
    return (control: AbstractControl): ValidationErrors | null => {
      const value = (control.value ?? '').toString();
      if (!value) {
        return null;
      }
      const longEnough = value.length >= 8;
      const hasLetter = /[A-Za-z]/.test(value);
      const hasNumber = /\d/.test(value);
      return longEnough && hasLetter && hasNumber ? null : { weakPassword: true };
    };
  }

  /** Cross-field validator: attach to the parent FormGroup, compares the
   *  named password and confirm-password controls. */
  static passwordsMatch(passwordKey: string, confirmKey: string): ValidatorFn {
    return (group: AbstractControl): ValidationErrors | null => {
      const password = group.get(passwordKey)?.value;
      const confirm = group.get(confirmKey)?.value;
      if (!confirm) {
        return null;
      }
      return password === confirm ? null : { passwordMismatch: true };
    };
  }
}
