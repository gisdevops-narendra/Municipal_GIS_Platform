// First: fills crypto.randomUUID / crypto.subtle.digest when the app is
// opened over plain HTTP on a LAN IP (Keycloak sign-in needs them).
import './insecure-context-crypto';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

// Back from a Keycloak account action (change password / email): the
// result is in the callback URL, which keycloak-js clears during start-up.
// Keep it so the app can confirm it (see AuthService.takeActionResult).
try {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search);
  const status = params.get('kc_action_status');
  if (status) sessionStorage.setItem('kc_action_status', status);
} catch {
  /* storage unavailable — the confirmation is just skipped */
}

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
