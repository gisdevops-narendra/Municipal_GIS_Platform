# Keycloak Authentication (Task 2)

Local development setup for Keycloak-based authentication. Keycloak is the
identity provider; Angular never authenticates users itself.

```
Angular + PrimeNG → Keycloak (OIDC/OAuth2) → JWT access token → Angular Auth Layer → Protected Dashboard
```

## 1. Start Keycloak

```bash
docker compose up -d
```

This starts a single Keycloak 26 container in dev mode (`start-dev`), using
its built-in embedded database — no separate Postgres/Redis is needed for
Keycloak itself. On first boot it auto-imports the realm defined in
`keycloak/import/municipal-gis-realm.json`.

- Keycloak: http://localhost:8180 (mapped from container port 8080; host
  8080 is often already taken by other local services)
- Admin console: http://localhost:8180/admin (`admin` / `admin` — dev-only
  bootstrap credentials, see `docker-compose.yml`)

Stop it with `docker compose down` (add `-v` to also wipe the dev database).

## 2. Realm & client

Everything below is created automatically by the realm import. To recreate
it by hand instead (e.g. against a fresh Keycloak with a different setup):

1. Admin console → **Create realm** → name it `municipal-gis`.
2. **Clients → Create client**:
   - Client ID: `municipal-gis-frontend`
   - Client type: OpenID Connect
   - Client authentication: **off** (public client — SPAs must not hold a
     client secret)
   - Standard flow: **on**, Direct access grants: **off**
   - Valid redirect URIs: `http://localhost:4200/*`
   - Web origins: `http://localhost:4200`
   - Advanced tab → Proof Key for Code Exchange: **S256**

We do not create a realm per municipality yet — the multi-tenant identity
strategy is a later decision.

## 3. Development test user

Also created automatically by the import:

| Field    | Value                         |
|----------|-------------------------------|
| Username | `testuser`                    |
| Password | `Test@1234`                   |
| Email    | `testuser@municipal-gis.dev`  |

To add another one by hand: Admin console → **Users → Add user**, then set
a password under the **Credentials** tab (toggle **Temporary** off).

## 4. Environment variables

`src/environments/environment.ts` (dev) and `environment.production.ts`
(prod, wired via `fileReplacements` in `angular.json`):

```ts
export const environment = {
  production: false,
  appUrl: 'http://localhost:4200',
  keycloak: {
    url: 'http://localhost:8180',
    realm: 'municipal-gis',
    clientId: 'municipal-gis-frontend'
  },
  apiUrl: 'http://localhost:3000/api' // future NestJS backend, unused today
};
```

No secrets live here — the client is public (no client secret), which is
the only correct client type for a browser SPA. Change these values (or
template the file at build time) for other environments; never commit real
production values.

## 5. How Angular connects to Keycloak

`app.config.ts` calls `provideKeycloak()` (from `keycloak-angular`) with the
config above and `initOptions: { onLoad: 'check-sso', ... }`. On app boot
this silently checks (via a hidden iframe, `public/silent-check-sso.html`)
whether the browser already has a Keycloak session — no visible redirect
happens for anonymous visitors, so the public landing page stays public.
`withAutoRefreshToken()` keeps the access token refreshed in the background
while the user is active.

`AuthService` (`src/app/core/services/auth.service.ts`) is the only place
that talks to the `keycloak-js` instance directly. It exposes:

- `isAuthenticated` / `user` — Angular signals, reactive in templates
- `login(options?)`, `logout(redirectUri?)`
- `getToken()`, `getUser()`, `refreshToken(minValiditySeconds?)`

Components and other services should depend on `AuthService`, never on
`Keycloak`/`keycloak-angular` directly.

## 6. How login works

The `/login` screen (`src/app/features/auth/login`) is preserved from
Task 1. It no longer collects a password: doing so would be a second,
custom authentication path competing with Keycloak. The optional email
field is passed to Keycloak only as a `loginHint`. Submitting the form calls
`AuthService.login()`, which redirects the browser to the Keycloak-hosted
login page. After a successful login there, Keycloak redirects back to
`/dashboard` with an authorization code, which `keycloak-js` exchanges for
tokens (PKCE, no client secret involved).

## 7. How logout works

`AuthService.logout()` calls `keycloak.logout()`, which redirects through
Keycloak's `end_session_endpoint` (clearing the Keycloak session) and back
to the app root. The site header's **Logout** button (shown only when
authenticated) triggers this.

## 8. How route protection works

`src/app/core/guards/auth.guard.ts` uses `createAuthGuard` from
`keycloak-angular` and is attached to `/dashboard` in `app.routes.ts`. If
the user is not authenticated, it calls `keycloak.login()` with the
originally requested URL as the redirect target, so the user lands back on
`/dashboard` after logging in. This is authentication only — no
role/permission checks are applied at this stage.

## 9. HTTP interceptor

`core/interceptors/bearer-token.interceptor.config.ts` configures the
library's `includeBearerTokenInterceptor` (registered in `app.config.ts`)
to attach `Authorization: Bearer <token>` only to requests whose URL starts
with `environment.apiUrl`. As of Task 3, the NestJS backend exists and
`CurrentUserService`/`MunicipalityService` call it — see
[docs/backend.md](backend.md). Components never attach the token
themselves; this interceptor is the only place that happens.

## Known limitations (by design for this task)

- Single shared realm; multi-tenant strategy (e.g. realm-per-municipality)
  is a later decision.
- No departments, invitations, or granular roles/permissions — see
  [docs/backend.md](backend.md) (Task 3) for the current
  Municipality/User/MUNICIPALITY_OWNER model, which these build on later.

As of Task 3, registration DOES create a real Keycloak user (via the
backend's Admin API integration) and a matching PostgreSQL record — see
[docs/backend.md](backend.md).
