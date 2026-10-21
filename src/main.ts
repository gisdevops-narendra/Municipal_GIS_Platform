// First: fills crypto.randomUUID / crypto.subtle.digest when the app is
// opened over plain HTTP on a LAN IP (Keycloak sign-in needs them).
import './insecure-context-crypto';
import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { AppComponent } from './app/app.component';

bootstrapApplication(AppComponent, appConfig)
  .catch((err) => console.error(err));
