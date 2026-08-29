import { Component, OnInit, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { ButtonModule } from 'primeng/button';
import { InputTextModule } from 'primeng/inputtext';
import { MessageModule } from 'primeng/message';
import { SiteHeaderComponent } from '../../../shared/components/site-header/site-header.component';
import { SiteFooterComponent } from '../../../shared/components/site-footer/site-footer.component';
import { AuthService } from '../../../core/services/auth.service';

/**
 * Login screen. Keycloak is the actual authentication authority: this form
 * no longer collects or validates a password locally — doing so would be a
 * second, custom authentication path competing with Keycloak. The optional
 * email field is only passed to Keycloak as a `loginHint` to pre-fill its
 * hosted login page; the credential itself is always entered on Keycloak.
 */
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    RouterLink,
    ButtonModule,
    InputTextModule,
    MessageModule,
    SiteHeaderComponent,
    SiteFooterComponent
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss'
})
export class LoginComponent implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);

  redirecting = false;
  loginError = false;
  forgotError = false;

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.email]]
  });

  get email() {
    return this.form.controls.email;
  }

  ngOnInit(): void {
    if (this.auth.isAuthenticated()) {
      this.router.navigateByUrl('/dashboard');
    }
  }

  /** Redirects to the Keycloak-hosted login page. Keycloak returns the
   *  browser to /dashboard on success. */
  onSubmit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.redirecting = true;
    this.loginError = false;
    // Wrap in Promise.resolve() so a *synchronous* throw from the Keycloak
    // adapter (e.g. not yet initialized, or crypto.subtle unavailable when
    // the app isn't served from localhost) becomes a rejection we catch here
    // — rather than escaping (ngSubmit) and letting the <form> do a native
    // page-reloading submit.
    Promise.resolve()
      .then(() =>
        this.auth.login({
          redirectUri: window.location.origin + '/dashboard',
          loginHint: this.email.value || undefined
        })
      )
      .catch((err) => {
        console.error('Keycloak login failed to start', err);
        this.redirecting = false;
        this.loginError = true;
      });
  }

  /** Redirects to Keycloak's hosted "Forgot Your Password?" page. No email
   *  needs to be entered here — Keycloak collects it and sends the reset
   *  link. Same defensive Promise.resolve() wrapper as onSubmit(). */
  onForgotPassword(): void {
    this.forgotError = false;
    Promise.resolve()
      .then(() => this.auth.forgotPassword(window.location.origin + '/login'))
      .catch((err) => {
        console.error('Keycloak reset-credentials redirect failed', err);
        this.forgotError = true;
      });
  }
}
