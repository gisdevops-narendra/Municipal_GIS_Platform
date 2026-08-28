/**
 * Development environment configuration.
 *
 * This file is used by `ng serve` (configuration: development) and by
 * `ng build` unless the `production` file replacement is applied — see
 * angular.json > projects.municipal-gis-platform.architect.build.configurations.
 *
 * No secrets belong here: the Keycloak client below is a public SPA client
 * (no client secret), which is the only client type an Angular app should
 * ever hold credentials for.
 */
export const environment = {
  production: false,
  /** Shown in Settings → About. Bump alongside a release. */
  version: '1.0.0-dev',
  appUrl: 'http://localhost:4200',
  keycloak: {
    url: 'http://localhost:8180',
    realm: 'municipal-gis',
    clientId: 'municipal-gis-frontend'
  },
  /** Placeholder for the future NestJS API. No requests are made yet — this
   *  only tells the bearer-token interceptor which origin it may attach the
   *  Keycloak access token to. */
  apiUrl: 'http://localhost:3000/api',
  /** GeoServer's browser-facing base URL (Task 6). Angular talks to
   *  GeoServer's public, anonymous OGC endpoints (WMS/WFS/GetLegendGraphic)
   *  directly for map tiles/features — never its REST Admin API, and never
   *  with credentials (see docs/backend.md "GIS Layers" for why this is
   *  safe: those endpoints are read-only and unauthenticated by GeoServer's
   *  own default config). Workspace/layer *names* always come from the
   *  backend's tenant-scoped APIs, never hardcoded here — this is only the
   *  "which server" part, analogous to apiUrl/keycloak.url above. */
  geoserverUrl: 'http://localhost:8600/geoserver'
};
