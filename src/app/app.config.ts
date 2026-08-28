import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { providePrimeNG } from 'primeng/config';
import {
  provideKeycloak,
  withAutoRefreshToken,
  includeBearerTokenInterceptor,
  INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG,
  AutoRefreshTokenService,
  UserActivityService
} from 'keycloak-angular';

import { routes } from './app.routes';
import { MgpPreset } from './core/theme/mgp-preset';
import { environment } from '../environments/environment';
import { bearerTokenInterceptorConfig } from './core/interceptors/bearer-token.interceptor.config';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideAnimationsAsync(),
    providePrimeNG({
      theme: {
        preset: MgpPreset,
        options: {
          darkModeSelector: false
        }
      }
    }),
    provideHttpClient(withInterceptors([includeBearerTokenInterceptor])),
    { provide: INCLUDE_BEARER_TOKEN_INTERCEPTOR_CONFIG, useValue: bearerTokenInterceptorConfig },
    // keycloak-angular's withAutoRefreshToken() feature injects these two
    // services internally, but neither is `providedIn: 'root'` and
    // provideKeycloak() never registers them itself — without this, the
    // app fails at bootstrap with "NullInjectorError: No provider for
    // AutoRefreshTokenService". Known gap in keycloak-angular@19.0.2.
    AutoRefreshTokenService,
    UserActivityService,
    provideKeycloak({
      config: {
        url: environment.keycloak.url,
        realm: environment.keycloak.realm,
        clientId: environment.keycloak.clientId
      },
      initOptions: {
        onLoad: 'check-sso',
        silentCheckSsoRedirectUri: `${window.location.origin}/silent-check-sso.html`,
        pkceMethod: 'S256',
        // Modern browsers block the third-party cookies the session-status
        // iframe needs (Keycloak is a different origin than this SPA), so the
        // iframe check misfires as "logged out" and drives a redirect loop
        // between /dashboard and Keycloak. Token freshness is handled by
        // withAutoRefreshToken() below instead.
        checkLoginIframe: false
      },
      features: [withAutoRefreshToken({ onInactivityTimeout: 'none' })]
    })
  ]
};
