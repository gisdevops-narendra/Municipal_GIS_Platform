/**
 * Production environment configuration.
 *
 * Applied via the `production` file replacement in angular.json. These
 * values are placeholders for local/staging builds only — real deployments
 * must override them (e.g. at build time via CI, or by templating this file
 * from real deployment configuration). Never commit production secrets;
 * note there are none to commit, since the Keycloak client here is a public
 * SPA client with no client secret.
 */
export const environment = {
  production: true,
  appUrl: 'http://localhost:4200',
  keycloak: {
    url: 'http://localhost:8180',
    realm: 'municipal-gis',
    clientId: 'municipal-gis-frontend'
  },
  apiUrl: 'http://localhost:3000/api',
  geoserverUrl: 'http://localhost:8600/geoserver'
};
