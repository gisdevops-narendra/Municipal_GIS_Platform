# Backend: Municipality, Departments, Users & GIS Workspace (Tasks 3-7)

NestJS API backing municipality registration, department management,
municipality user management, and the municipal GIS workspace. Scope is
deliberately narrow: Municipality → Department → User, Municipality →
GISWorkspace (1:1), two system roles (`MUNICIPALITY_OWNER`,
`MUNICIPALITY_USER`), and Keycloak-derived tenant + role context. No GIS
layers, file ingestion, or a granular permission engine yet.

```
Angular → Keycloak (JWT) → NestJS (backend/) → PostgreSQL + PostGIS
                                             ↘︎ GeoServer (workspace/datastore only)
```

## 1. Stack

- NestJS 11 + TypeScript, in `backend/`
- PostgreSQL 16 + PostGIS 3.4, via Prisma ORM (`backend/prisma/schema.prisma`)
- GeoServer 2.25 (`kartoza/geoserver` Docker image) — server-side only, see §14
- Auth: `passport-jwt` + `jwks-rsa`, validating Keycloak-issued RS256 JWTs
  (signature, issuer, expiry, and that the token was issued to the known
  frontend client) — see `backend/src/auth/`

## 2. Start the dev stack

```bash
cp .env.example .env          # optional — sane defaults work with no .env
docker compose up -d          # keycloak, postgres (postgis), geoserver, backend
```

`docker compose up -d` starts all the containerized services — Keycloak,
PostGIS-enabled Postgres, GeoServer, and the backend (Angular is the fifth
piece, run on the host via `ng serve` as before). The `backend` service
bind-mounts `./backend` and runs `npm run start:dev`, so backend code
changes hot-reload the same way `ng serve` does for the frontend.

If you'd rather iterate on the backend directly on the host (faster
edit/reload, easier debugging):

```bash
docker compose up -d postgres keycloak geoserver
cd backend
cp .env.example .env
npm install
npm run start:dev
```

Then, in a separate terminal, run the frontend as usual (`ng serve` from
the repo root — see the main [README](../README.md)).

Host port 5432 is often already taken by a local Postgres install; override
`POSTGRES_PORT` in the root `.env` if so (see `.env.example`). Likewise
`GEOSERVER_PORT` (default 8600) if 8080 territory is contested.

GeoServer takes ~15-20s to finish booting after its container starts; the
backend tolerates this (provisioning is retry-safe, see §16) rather than
requiring GeoServer to be ready before it starts.

**If a brand-new backend source file doesn't show up in the running
container** (route 404s despite the file existing on both host and
container, `nest start --watch` logging "Found 0 errors"): the
`backend-dist` named volume (see its comment in `docker-compose.yml`) can
retain stale webpack incremental output that doesn't always pick up
files created while the container is already running, as opposed to
edits to existing files. Fix:
`docker exec municipal-gis-backend sh -c "rm -rf dist/*"` then `docker
compose restart backend`. Found and fixed live during Task 6.

## 3. Migrations

```bash
cd backend
npx prisma migrate dev --name <change-description>   # create + apply a new migration (local dev)
npx prisma migrate deploy                             # apply existing migrations only (CI/other envs)
npx prisma generate                                    # regenerate the Prisma client after a schema change
```

Or, against the Dockerized backend/Postgres without a local Node install:

```bash
docker compose exec backend npx prisma migrate deploy
```

**Reset the dev database** (drops all data, reapplies every migration —
never do this against anything but a local dev database):

```bash
cd backend
npx prisma migrate reset
```

Migrations live in `backend/prisma/migrations/` and are committed to the
repo — never edit an already-applied migration file; create a new one.

**PostGIS**: the `20260826121331_add_gis_workspace_and_postgis` migration
runs `CREATE EXTENSION IF NOT EXISTS postgis;` explicitly. This is
belt-and-braces: a brand-new `postgres-data` volume already gets PostGIS
enabled automatically by the `postgis/postgis` image's own init scripts,
but those scripts do NOT re-run against a pre-existing volume (e.g.
upgrading a database created back in Task 3/4, before this image change) —
the explicit `CREATE EXTENSION IF NOT EXISTS` in the migration covers that
case too, idempotently. Verify it worked:

```bash
docker exec municipal-gis-postgres psql -U municipal_gis -d municipal_gis -c "SELECT PostGIS_Version();"
```

**Regenerating the Prisma client inside the backend container**: if you
change `schema.prisma` while the containerized backend is already running,
its `node_modules/@prisma/client` (a separate Docker volume from your host's)
won't pick up the change until you regenerate it there too:

```bash
docker exec municipal-gis-backend npx prisma generate
```

(`prisma migrate dev` from the host already regenerates the *host's*
client automatically — this is only needed for the container's copy.)

## 4. Environment variables

See `backend/.env.example` (standalone/local dev) and the root
`.env.example` (Docker Compose). Notably:

- `KEYCLOAK_URL` must equal the **browser-facing** Keycloak origin (e.g.
  `http://localhost:8180`), because that's what Keycloak stamps into every
  token's `iss` claim, which the backend validates against.
- `KEYCLOAK_INTERNAL_URL` is optional and only needed when the backend
  itself runs inside Docker Compose, where it reaches Keycloak as
  `http://keycloak:8080` on the compose network — a different address than
  the browser uses. It defaults to `KEYCLOAK_URL` otherwise. See
  `backend/src/auth/strategies/keycloak-jwt.strategy.ts` for details.
- `KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET` are the
  confidential service-account client the backend uses server-side to call
  the Keycloak Admin API when registering a new municipality owner (see
  §6). Never exposed to Angular.
- `GEOSERVER_URL`, `GEOSERVER_ADMIN_USER`, `GEOSERVER_ADMIN_PASSWORD` —
  GeoServer's REST Admin API, called only by this backend (see §14). Never
  exposed to Angular; there is no browser-facing GeoServer URL at all.
- `POSTGIS_HOST` / `POSTGIS_PORT` / `POSTGIS_DATABASE` / `POSTGIS_USER` /
  `POSTGIS_PASSWORD` — connection parameters GeoServer's per-municipality
  datastores are configured with. **Not** the same audience as
  `POSTGRES_HOST`/`DATABASE_URL`: those describe how *this backend process*
  reaches Postgres (which differs between running on the host vs. in
  Docker Compose), while `POSTGIS_HOST` describes how *GeoServer* reaches
  it — and GeoServer always runs inside Docker Compose, so `POSTGIS_HOST`
  is always the compose service name `postgres`, even when you run the
  backend itself with `npm run start:dev` on the host. See the comment in
  `backend/.env.example`.
- `GIS_UPLOAD_STORAGE_DIR` / `GIS_UPLOAD_MAX_FILE_SIZE_MB` /
  `GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB` / `GIS_UPLOAD_MAX_ZIP_FILE_COUNT`
  — Task 7 GIS upload storage location and limits (see §28/§34). All
  configurable; never hard-coded in application code. Development
  defaults: 500 MB / 2 GB / 100 files.

## 5. Database model

`Municipality` 1—many `Department`, and `Municipality` 1—many `User` with
an optional `User` → `Department` link (nullable: the owner belongs to no
department). See `backend/prisma/schema.prisma`.

Two `systemRole` values: `MUNICIPALITY_OWNER` (exactly one per
municipality, created during registration, never accepted from the client)
and `MUNICIPALITY_USER` (created by the Owner, see §7). Both are enforced
server-side — see `backend/src/municipalities/dto/register-municipality.dto.ts`
and `backend/src/users/dto/create-user.dto.ts`, neither of which has a
`role` field at all.

`Department.name` and `Department.code` are each unique **within a
municipality** (composite `@@unique([municipalityId, name/code])`), enforced
at the database level, not just in application code — the same name/code
can be reused across different municipalities.

`Municipality` also has exactly one `GISWorkspace` (`@unique` on the FK,
making it a true 1:1) — see §14.

**Audit fields**: `Department`, `User`, and `GISWorkspace` all carry
`createdAt`, `updatedAt`, and `createdById` (`GISWorkspace` also has
`updatedById`) — the acting Owner's `User.id`; null for the self-registered
owner/their own workspace. These are plain columns, not Prisma relations,
and there is no history/change-log table — a full audit trail (who changed
what, when, previous values) is out of scope for this task and would be a
follow-up (e.g. an `AuditLog` table or a library like `nestjs-cls` +
Prisma middleware).

## 6. Registration flow

`POST /api/municipalities/register` (public — no Keycloak session exists
yet at this point):

1. Rejects duplicates (municipality official email, owner email) before
   touching Keycloak.
2. Creates the Keycloak user via the Admin API
   (`backend/src/keycloak/keycloak-admin.service.ts`), using the owner's
   chosen password. **The password is forwarded to Keycloak once and never
   stored in PostgreSQL.**
3. Creates the `Municipality` + owner `User` (role forced to
   `MUNICIPALITY_OWNER`, linked via the Keycloak user id returned in step
   2) + a `GISWorkspace` row (status `PROVISIONING`) in a single Prisma
   `$transaction` — all three succeed or none do.
4. If step 3 fails after step 2 succeeded, the Keycloak user is deleted as
   a best-effort compensating action, so a Keycloak identity never survives
   with no matching application user.
5. Once the transaction commits, provisions the GeoServer side (workspace +
   PostGIS datastore) for the new `GISWorkspace` — see §16. This is
   necessarily outside the DB transaction (GeoServer is an external HTTP
   service, not a participant in a Postgres transaction); if it fails, the
   municipality/owner/workspace row are kept, not rolled back — the
   workspace is left `PROVISIONING_FAILED` and can be retried (§16).

The Angular registration wizard (`/register/...`) still collects the
password (Keycloak, not this backend, owns it) and calls this endpoint from
`ReviewComponent` via `MunicipalityService`. After success, the existing
`/register/success` → `/login` handoff from Task 1 is unchanged — the user
signs in through Keycloak with the credentials just created.

## 7. Authenticated endpoints & authorization

Every protected endpoint runs through two guards in order:

1. **`KeycloakJwtGuard`** — validates the JWT (signature, issuer, expiry,
   client) and sets `request.user` to the token claims.
2. **`AppUserGuard`** — resolves the application `User` row for that
   Keycloak identity, rejects it if `status !== ACTIVE` (see §9), and sets
   `request.appUser` (id, municipalityId, departmentId, systemRole) for
   everything downstream. This is what makes deactivating a user actually
   take effect on their very next API call.

Owner-only endpoints add a third guard, **`RolesGuard`**, driven by a
`@Roles('MUNICIPALITY_OWNER')` metadata decorator. Rather than composing
these three by hand on every controller method, use the convenience
decorators in `backend/src/auth/decorators/authorization.decorators.ts`:

- `@RequireMunicipalityMember()` — any authenticated, active user in the
  tenant (both roles). Use for read endpoints.
- `@RequireMunicipalityOwner()` — `MUNICIPALITY_OWNER` only; a
  `MUNICIPALITY_USER` gets a clean 403. Use for create/update/deactivate.

Endpoints:

| Method & path                    | Access                | Notes |
|-----------------------------------|------------------------|-------|
| `POST /api/municipalities/register` | Public               | Task 3 |
| `GET /api/me`                     | Member                | Task 3 |
| `GET /api/municipalities/current` | Member                | Task 3, tenant-isolation demo |
| `GET /api/departments`            | Member                | |
| `GET /api/departments/:id`        | Member                | |
| `POST /api/departments`           | Owner                 | |
| `PATCH /api/departments/:id`      | Owner                 | name/code/description/status |
| `DELETE /api/departments/:id`     | Owner                 | rejects (409) if users are assigned — see §8 |
| `GET /api/users`                  | Member                | filters: `departmentId`, `status`, `search` |
| `GET /api/users/:id`              | Member                | |
| `POST /api/users`                 | Owner                 | always creates `MUNICIPALITY_USER` — see §10 |
| `PATCH /api/users/:id`            | Owner                 | fullName/mobileNumber/departmentId (not email) |
| `PATCH /api/users/:id/status`     | Owner                 | ACTIVE/DISABLED — see §9 |
| `GET /api/gis/workspace`          | Member                | caller's own municipality's workspace — see §14 |
| `PATCH /api/gis/workspace`        | Owner                 | name/description/defaultCrs/displayCrs — see §15 |
| `POST /api/gis/workspace/provision` | Owner               | retries GeoServer provisioning — see §16 |
| `GET /api/gis/geoserver/health`   | Member                | 503 if GeoServer is unreachable — see §17 |

The `MUNICIPALITY_OWNER` row itself can never be modified through
`PATCH /api/users/:id[/status]` — `UsersService.assertManageableUser`
refuses with 403 even for the Owner acting on their own record, satisfying
"the Owner cannot be deleted/managed by another user" without needing an
owner-transfer feature.

## 8. Department delete safety

`DELETE /api/departments/:id` never silently removes a department that
still has users assigned. If `userCount > 0` it rejects with a clear 409
(`Cannot delete "X" — it has N user(s) assigned. Deactivate it instead.`);
the Owner uses `PATCH /api/departments/:id` with `{ "status": "INACTIVE" }`
instead. A department can only be hard-deleted once it has zero users. See
`backend/src/departments/departments.service.ts`.

## 9. Deactivating a user

`PATCH /api/users/:id/status` with `{ "status": "DISABLED" }` does two
things:

1. Sets `User.status = DISABLED` in Postgres.
2. Best-effort revokes all of that user's active Keycloak sessions
   (`KeycloakAdminService.logoutUserSessions`) — kills an already-open
   browser session immediately.

Independently of both, **`AppUserGuard` rejects every request from a
`DISABLED` user on every subsequent call**, regardless of whether their JWT
is still cryptographically valid or whether they log in again — Keycloak's
`enabled` flag is deliberately left untouched (see §10), so a fresh login
succeeds at the identity-provider level, but the very next call to this
API returns 403 `"This account has been deactivated."`. This is the
authentication/session strategy referenced in Task 4's test plan: real
lockout happens at the application layer, not by revoking the Keycloak
account.

## 10. Owner-created users

`POST /api/users` follows the same create-Keycloak-user-then-transact-then-
compensate pattern as Task 3's municipality registration:

1. Validates the target department belongs to the actor's own municipality
   (404 otherwise) and that the email isn't already registered (409).
2. Creates the Keycloak user via the Admin API with a **strong, randomly
   generated temporary password** (`credentials[].temporary: true`,
   `requiredActions: ['UPDATE_PASSWORD']`) — the Owner does not, and must
   never, choose another person's password.
3. Creates the `User` row (role forced to `MUNICIPALITY_USER`) in the same
   try/catch; if it fails, the Keycloak user is deleted as a compensating
   action (best-effort, never masks the original error).
4. Returns the temporary password **once**, in the API response body, for
   the Owner to share with the new user out of band.

There is no email/invite-link delivery system in this task's scope — that
is the natural follow-up (replace step 4 with an emailed invite link and
drop the plaintext password from the response entirely). The password is
never logged and never persisted in PostgreSQL.

## 14. GIS Workspace concept

Every municipality gets exactly **one permanent GIS Workspace** — not a
project, not something the Owner creates by hand. It is created
automatically as part of municipality registration (§6) and mirrors onto
GeoServer as one workspace + one PostGIS datastore:

```
Somnath Municipality
        ↓ (1:1)
   GISWorkspace (Postgres row: name, code, CRS config, status)
        ↓ mirrors onto
   GeoServer workspace "somnath_municipality"
        ↓ contains
   PostGIS datastore "somnath_municipality_postgis"
        ↓ will eventually contain (NOT built in Task 5)
   Published feature layers (Ward, Road, Parcel, streetlight, ...)
```

Future *projects* may create temporary/draft GIS data, but they are never
separate permanent workspaces — there is one municipality, one workspace,
always. See `backend/src/gis/`.

## 15. GeoServer workspace naming

GeoServer workspace names appear in URLs and XML namespaces, so they must
be safe: lowercase, no spaces, no punctuation, starting with a letter — and
since one GeoServer instance is shared by every municipality, **globally**
unique (not just unique per municipality, unlike `Department.code`).

`backend/src/gis/workspace-naming.util.ts` exports a pure `slugifyWorkspaceName`
function (lowercases, strips diacritics/punctuation, collapses separators,
prefixes `ws_` if the result would start with a digit, bounds the length).
It is deterministic but not on its own guaranteed unique — two municipalities
can slugify to similar names. `GisWorkspaceService.generateUniqueGeoserverWorkspaceName`
checks the candidate against existing `GISWorkspace.geoserverWorkspace`
values (also backed by a DB `@unique` constraint) and appends `_2`, `_3`,
... until it finds a free one. Never derived from anything the frontend
supplies beyond the municipality's own validated `name`.

`GISWorkspace.code` (e.g. `SOMNATH_MUNICIPALITY_GIS`) is derived the same
way but has no uniqueness requirement of its own.

## 16. GeoServer provisioning

`GeoServerService` (`backend/src/gis/geoserver.service.ts`) is a thin,
low-level REST client — one method per GeoServer REST call
(`ensureWorkspace`, `ensurePostgisDatastore`, `checkDatastoreConnection`,
`checkHealth`, ...), each idempotent where it matters (checks existence
before creating, so calling it twice never creates a duplicate).

`GisWorkspaceService.provisionWorkspace` orchestrates them:

1. `ensureWorkspace` — create the GeoServer workspace if it doesn't exist.
2. `ensurePostgisDatastore` — create a PostGIS datastore inside it, pointed
   at the same shared Postgres instance (see §19 — Task 5 deliberately
   does not stand up per-municipality databases or schemas yet).
3. `checkDatastoreConnection` — asks GeoServer to list feature types
   through the datastore; this fails if the underlying DB connection is
   actually broken, confirming the datastore isn't just configured but
   working.
4. On success, sets `GISWorkspace.status = ACTIVE`. On any failure at any
   step, sets `PROVISIONING_FAILED` instead of throwing — a GeoServer
   outage during registration never fails the registration response or
   deletes the municipality (see §6).

**Retrying**: `POST /api/gis/workspace/provision` (Owner-only) re-runs the
exact same idempotent method for the caller's own workspace — safe to call
as many times as needed, e.g. after bringing GeoServer back up. `GET
/api/gis/workspace` also self-heals a *missing* workspace row (a
municipality registered before Task 5 existed) by creating one and
provisioning it once, so that legacy data doesn't need a manual migration
step to become GIS-enabled.

## 17. GeoServer health & security

`GET /api/gis/geoserver/health` (member-level, not public) calls
`GeoServerService.checkHealth`, which hits GeoServer's own
`/rest/about/version.json` with a 5s timeout. Reachable → `200 {status:
"UP", version}`. Unreachable → `503` via `ServiceUnavailableException`
(mapped to a clean body by `AllExceptionsFilter`, no stack trace).

GeoServer admin credentials (`GEOSERVER_ADMIN_USER`/`GEOSERVER_ADMIN_PASSWORD`)
live only in backend environment variables and are used only inside
`GeoServerService`. Angular never talks to GeoServer directly and never
sees these credentials — every GIS-related request from the browser goes
to NestJS, which is the only thing that calls GeoServer's REST API.

## 18. CRS strategy

`GISWorkspace.defaultCrs` (storage/projected CRS, e.g. `EPSG:32643` — UTM
zone 43N) and `.displayCrs` (geographic, `EPSG:4326` — WGS84) are
per-workspace columns, not hardcoded constants baked into layer logic.
`EPSG:32643` is only the *default* applied at provisioning time — chosen
because it suits the initial Gujarat/Somnath development environment, not
because every Indian municipality uses the same UTM zone. The Owner can
change both via `PATCH /api/gis/workspace` (validated as `EPSG:\d{4,6}`).
Automatic CRS detection from uploaded data is explicitly deferred — that
belongs to a future GIS-ingestion task, not this one.

## 19. Tenant isolation

The backend never trusts a client-supplied `municipality_id` (or
`departmentId` used for authorization). Tenant identity always flows: JWT
→ Keycloak user id (`sub`) → application `User` row (`AppUserGuard`) →
`municipalityId`. Every department/user/GIS-workspace query is scoped by
that value — a row belonging to another municipality simply never matches,
so it looks identical to "not found" (404), not "forbidden". The GIS
workspace endpoints go a step further: they take no `id`/`workspaceId`
parameter of any kind — `GET/PATCH /api/gis/workspace` always mean "my own
municipality's workspace", so there is nothing for a client to
tamper with in the first place.

One shared PostGIS-enabled PostgreSQL instance serves every municipality
in this task (§ "Database schema organization" in the task brief) — the
`GISWorkspace` row is the *logical* tenant boundary today. Schema-per-tenant,
row-level security, or a dedicated database for large municipalities are
future options, deliberately not built now.

See:
- `backend/src/municipalities/tenant-isolation.spec.ts` (Task 3, municipality-level)
- `backend/src/departments/departments.service.spec.ts` ("tenant isolation" describe block)
- `backend/src/users/users.service.spec.ts` ("tenant isolation" describe block)
- `backend/src/gis/gis-workspace.service.spec.ts` ("tenant isolation" describe block)
- `backend/src/auth/guards/authorization.spec.ts` (AppUserGuard/RolesGuard unit tests)

## 22. GIS Layers & 2D Map Viewer (Task 6)

`GET /api/gis/layers` (member-level) returns the requesting user's
municipality's published GIS layers — Angular's OpenLayers map (see
`docs/frontend.md`-equivalent notes below, or the Task 6 report) fetches
this exactly once per screen visit and never re-fetches on visibility
toggles, which only touch already-created OpenLayers layers client-side.

`GISLayer` (table `gis_layers`) stores per-layer metadata, one row per
municipality per layer: `code` (`MUNICIPAL_BOUNDARY`/`WARDS`/`ROADS`),
`layerType` (`VECTOR`/`RASTER`), `geometryType`
(`POINT`/`LINE`/`POLYGON`), `geoserverWorkspace`/`geoserverLayer` (which
published featuretype it maps to), `visibleByDefault`, `displayOrder`,
and a `bboxMinX/Y`/`bboxMaxX/Y` (EPSG:4326) captured from GeoServer at
publish time — this is what lets the frontend compute an initial map
view without any hardcoded coordinates (see §25).

Three demonstration layers can be seeded into every municipality —
**hand-authored sample geometry, not real municipal GIS data**, clearly
labelled as such in their `description`:

| code | name | geometry | native table |
|---|---|---|---|
| `MUNICIPAL_BOUNDARY` | Municipality Boundary | Polygon | `gis_demo_municipal_boundary` |
| `WARDS` | Wards | Polygon | `gis_demo_wards` |
| `ROADS` | Roads | Line | `gis_demo_roads` |

**This is off by default.** A freshly registered municipality starts with
an empty layer list — nothing is created until its owner uploads real
data. Set `GIS_SEED_DEMO_LAYERS=true` to opt in (local demos, screenshots).

`GisLayersService.ensureDemoLayers(workspace)` idempotently creates the
`GISLayer` rows and publishes the matching GeoServer feature types. When
`GIS_SEED_DEMO_LAYERS` is not `"true"` it is a no-op. It never throws — a
single layer's publish failing (logged) does not affect the others or the
workspace's own status. It runs from
`GisWorkspaceService.provisionWorkspace()`, right after a workspace is
marked `ACTIVE`. There is **no** lazy backfill on read:
`GisLayersService.listForMunicipality()` returns exactly the `GISLayer`
rows that exist, and never creates any.

Actual demo *geometry* is separate from the metadata above — it is seeded
into the shared demo tables (Somnath, by default) via
`backend/prisma/seed-demo-gis-data.ts` (`npm run seed:gis-demo`),
idempotent and safe to re-run. With `GIS_SEED_DEMO_LAYERS=true`, freshly
registered municipalities get working layer metadata and published
(empty) featuretypes automatically, but no demo geometry until/unless
they're seeded too — the map still loads correctly, it just has nothing
to draw yet.

## 23. WMS / WFS & CQL-based tenant isolation for shared demo data

The three demo tables above are genuinely shared — one physical
PostgreSQL table each, holding every municipality's demo rows, each
tagged with a `gis_workspace_id` column (FK to `gis_workspaces.id`, `ON
DELETE CASCADE`), GIST-indexed geometry, and a `COMMENT ON TABLE` marking
them as Task 6 demo data.

Tenant isolation for this shared data is enforced **at the GeoServer OGC
service layer**, not just in application code: each municipality gets its
own GeoServer featuretype per layer (e.g.
`somnath_municipality:roads`,`junagadh_municipality:roads` — same
underlying `gis_demo_roads` table, same `nativeName`), published with a
CQL filter:

```
gis_workspace_id = '<this-municipality's-gis_workspace.id>'
```

set via `ensureFeatureType`'s `cqlFilter` param (`GeoServerService`,
POSTed as the featuretype's `cqlFilter` on creation). GeoServer applies
this filter to every WMS `GetMap`/`GetFeatureInfo` and WFS `GetFeature`
request against that featuretype — a municipality's published layer can
only ever return its own rows, even though the backing table holds every
tenant's data. This was verified empirically (not just unit-tested): a
throwaway two-tenant table + two CQL-filtered featuretypes were queried
directly via WFS before this was wired into the real code, and again via
the real published layers after (see the Task 6 report's Tests
Performed section).

Application layers add a second, independent isolation boundary on top —
`GET /api/gis/layers` never accepts a workspace/municipality id from the
caller (§19), and `GISLayer.geoserverWorkspace`/`geoserverLayer` are
always resolved server-side from the JWT.

**Known limitation**: GeoServer's WMS/WFS endpoints are themselves public
and anonymous by this task's own architecture (Angular renders map tiles
by talking to GeoServer directly — see §25 — and GeoServer admin
credentials must never reach the browser, which rules out per-request
backend-issued tokens for tile rendering). This means the CQL filter is
the *only* thing stopping one municipality's browser from directly
requesting another municipality's featuretype by name (e.g.
`somnath_municipality:roads`) — workspace/layer names are not secret.
For non-sensitive demonstration data this is an accepted tradeoff, not a
gap in the application's own tenant-isolation logic, but it is a real
constraint of the "Angular talks to GeoServer's public OGC endpoints
directly" architecture and should be weighed before any real (sensitive)
municipal data is published the same way — GeoServer layer-level security
(role-based OGC service access) or proxying OGC requests back through
NestJS are the two usual hardening paths.

## 24. GetFeatureInfo (click-to-identify)

The frontend issues one `WMS GetFeatureInfo` request per currently
*visible* vector layer at the clicked pixel
(`INFO_FORMAT=application/json`), scoped to that single layer so results
are unambiguous per layer. A layer that is toggled off is never queried —
verified live (§ Task 6 report, TEST 10). A GeoServer error or network
failure for one layer's query is caught and treated as "no features for
that layer" rather than failing the whole click (§29 of the task brief).
An empty click point simply returns zero features for every visible
layer — this is a normal, not-an-error outcome.

## 25. Frontend map architecture (OpenLayers)

Angular's `MapService` (`src/app/features/gis/services/map.service.ts`,
component-provided — one instance per `/gis` page visit, not
`providedIn: 'root'`) is the only place in the frontend that imports from
`ol`. Every other GIS component (layer panel, map controls, legend,
feature-info dialog) talks to it through plain methods and an Angular
signal (`layerVisibility`), never touching OpenLayers types directly.

`environment.geoserverUrl` is the *only* GeoServer-related frontend
config — the public base URL, analogous to `apiUrl`/`keycloak.url`.
Angular calls GeoServer's public, anonymous WMS/WFS endpoints directly
for map tiles/`GetFeatureInfo`/`GetLegendGraphic` (never the REST Admin
API), and every workspace/layer name it uses comes from the tenant-scoped
`GET /api/gis/layers` response — never typed in or guessable from the
frontend itself. `GEOSERVER_ADMIN_PASSWORD` exists only in backend
environment variables (§17) and is never referenced anywhere under
`src/environments/`.

The initial map view is computed from the `MUNICIPAL_BOUNDARY` layer's own
`bbox` (falling back to any other layer's bbox, then to a generic
India-wide view only if no layer has usable data yet) — never a hardcoded
coordinate, so a newly registered municipality anywhere in India gets a
sensible initial view with zero frontend code changes.

## 26. Print Layout (MapFish Print)

The GIS workspace's **Print Layout** tool (left dock) turns the live
OpenLayers map into a professional A4/A3, portrait/landscape, PDF or PNG
document — title, legend, scale bar, north arrow, date, metadata,
attribution.

**Pipeline.** `mapfish-print` (a compose service,
`camptocamp/mapfish_print:3.30`, backend-only — never exposed to the
browser) does the map compositing. Print templates live in
`mapfish-print/print-apps/municipal-gis/` (`config.yaml` + one
JasperReports 6.20 `.jrxml` per layout + `legend.jrxml` + `north-arrow.svg`)
and are mounted read-only into the container.

**The backend builds the spec, not the frontend** (`PrintService` /
`PrintController`, `backend/src/gis/print.*`). The Angular panel sends only
the live view (`center` + true `scale` + `rotation`, via
`MapService.getPrintContext()` — `center`+`scale`, never a bbox, so the
printed resolution matches the screen) and a list of **GISLayer ids**.
`PrintService.buildReport`:

1. `GisLayersService.listForMunicipality(appUser)` → the caller's
   tenant-scoped, permission-filtered layers. A requested `layerId` not in
   that list → `403` (**this is the print authorization boundary** — you
   can only print a layer you can already VIEW). Any member may print.
2. builds the MapFish v3 spec: each WMS layer's `baseURL` is
   `MAPFISH_GEOSERVER_URL` (`http://geoserver:8080/geoserver` — the
   compose-internal address, so the *print container* fetches the imagery,
   not the browser); the live `CQL_FILTER` is passed straight through;
   legend entries are GetLegendGraphic URLs on the same internal GeoServer.
3. the basemap is resolved from `basemapId` against a fixed server-side
   allowlist (`osm` / `carto-light` / `topo` / `none`) — the client never
   sends a URL, so MapFish can never be pointed at an arbitrary host.
4. POSTs to MapFish's synchronous `buildreport.<pdf|png>` (120 s timeout)
   and streams the binary back with a `Content-Disposition` filename
   (`main.ts` adds `Content-Disposition` to CORS `exposedHeaders` so the
   panel can read it). A MapFish error or unreachable engine → `503`.

`buildSpec` is a pure function (DTO + resolved layers → spec object), unit
tested in `print.service.spec.ts` without a running MapFish.

**Config.** `MAPFISH_PRINT_URL`, `MAPFISH_GEOSERVER_URL`,
`MAPFISH_PRINT_APP` (see `backend/.env.example`). MapFish adds ~1 GB RAM to
the stack. Basemap tiles need outbound internet from the print container;
`basemapId: 'none'` is the always-available offline path. `mapfish-print`
is a `service_started` (not `_healthy`) dependency of `backend` so a slow
print engine never blocks boot — print calls just 503 until it is up.

## 27. GIS Layer Styling (GeoServer + YSLD)

Every published layer can be styled — single symbol, categorized (unique
values), graduated (classified ranges), labels, scale-dependent
visibility. The style is authored as a structured **`LayerStyleSpec`**
(JSON, `backend/src/gis/dto/layer-style.dto.ts`), the backend turns it
into **YSLD**, GeoServer stores it as a workspace style, and the existing
`ImageWMS` layer re-renders.

**Infra.** GeoServer needs the YSLD extension — `docker-compose.yml` sets
`STABLE_EXTENSIONS: ysld-plugin` + `FORCE_DOWNLOAD_STABLE_EXTENSIONS`, so
kartoza downloads `geoserver-2.25.2-ysld-plugin.zip` on start (needs
internet, one-time). Offline fallback: drop the jar into `WEB-INF/lib`.

**Pieces** (`backend/src/gis/`):
- `YsldGenerator` — pure `spec → YSLD`, unit-tested; GeoServer's 400 on a
  bad PUT is the last line of defence. Handles point/line/polygon +
  raster symbolizers, categorized (`filter: ${field = 'v'}`, ECQL literal
  escaped) with an `else` rule, graduated (range filters from breaks,
  ramp colour per class), text symbolizers, `scale:` ranges.
- `FieldStatsService` — geometry + attributes from
  `information_schema.columns`; classification stats **straight from
  PostGIS** (`MIN`/`MAX`/`COUNT`, `percentile_cont` for quantile breaks,
  `DISTINCT … LIMIT 51` for categories). The field name is **whitelisted
  against the attribute list** before any query; the table name is
  `isSafeGeneratedTableName`-guarded (uploaded layers) or a fixed
  `gis_demo_*` name (canonical layers, with a `gis_workspace_id` filter).
- `StyleService` — style primitives (no tenant logic): `applyStyle` (PUT
  YSLD under `<layer>_style`, set it as the layer default),
  `removeStyle` (revert to the built-in `point`/`line`/`polygon` style,
  delete the custom one).
- `GeoServerService` — `putYsldStyle` / `getStyleBody` / `deleteStyle` /
  `setLayerDefaultStyle` (all workspace-scoped; invalid YSLD → 400 →
  `BadRequestException` with the parser message).

**Where the tenant/permission check lives.** `GisLayersService` (layer
target) and `GisUploadsService` (upload target) resolve + authorise the
layer (`findLayerInMunicipality` + `gisAuth.canManage` — owner in
practice, same as permission editing) then call the primitives.
`GISLayer` gains `styleName` + `styleSpec`; `GISLayerUpload` gains
`styleSpec`.

**Two entry points.**
1. Upload wizard Preview step → `PUT /api/gis/uploads/:id/style` restyles
   the `preview_<id>` featuretype on the wizard map and saves the spec on
   the upload. `publish()` re-applies that spec to the real `GISLayer`
   (best-effort — a style failure never blocks the publish).
2. Map layer panel / `/gis/layers` → `PUT /api/gis/layers/:id/style`
   generates YSLD, saves it, sets it as the layer default, persists the
   spec. The frontend then bumps a cache-bust param on the WMS source
   (`MapService.refreshLayerStyle`) so the styled render replaces the
   cached tiles — no second map instance. `DELETE …/style` reverts.

`deleteLayer` also deletes the layer's GeoServer style.

**Point icons (ExternalGraphic).** A point symbol may carry an
`icon: { source: 'builtin' | 'custom', name, mime }` instead of a vector
`mark`; `iconOpacity` and `iconAnchorX/Y` also apply. GeoServer renders an
ExternalGraphic as-is (it does **not** recolour it from YSLD), so the
editor hides the fill/outline pickers when an icon is chosen.
- **Built-in set** — 24 original CC0 marker icons in
  `backend/src/gis/marker-icons/` (`manifest.json` + one `.svg` each +
  `LICENSE.txt`; copied next to the compiled code via `nest-cli.json`
  assets — `outDir: dist/src` because this project emits to `dist/src/…`;
  `marker-icons/index.ts` also probes a few fallback dirs and never throws
  on a missing file). Public domain — no attribution required.
  `GET /api/gis/style/icons` lists them (auth);
  `GET /api/gis/style/icons/:id` serves the SVG — **unauthenticated on
  purpose**: the editor loads it as a plain `<img src>` (no JWT), and the
  files are static public art with no tenant data.
- **Custom upload** — `POST /api/gis/{layers|uploads}/:id/style/icon`
  (multipart `file`, ≤512 KB, SVG or PNG). `StyleService.uploadIcon`
  validates (PNG magic bytes; SVG is **rejected**, not repaired, if it
  contains a script / event handler / external `href` / entity), then
  stores it in the workspace's GeoServer style-resource dir under a
  content-hashed name `mgp_icon_<sha>.<ext>`. The proxy-back route
  `GET …/style/icon/:name` **is** tenant-scoped, so the editor fetches it
  via `HttpClient` as a blob and shows it through an object URL.
- **Resolution.** On `applyStyle`, `StyleService.resolveSpecIcons` deep-
  copies the spec and rewrites every `symbol.icon` to a resource filename
  GeoServer resolves against `workspaces/<ws>/styles/`: a built-in icon is
  pushed to the workspace on first use (`mgp_icon_builtin_<id>.svg`,
  idempotent) and its manifest anchor is applied when the user hasn't
  overridden it; a custom icon is already there. The **persisted**
  `styleSpec` keeps the logical ref (`source: 'builtin', name: 'pin'`), so
  it re-resolves cleanly on every re-apply. `GeoServerService` gains
  `putStyleResource` / `styleResourceExists` (HEAD) / `getStyleResource` /
  `deleteStyleResource`.

Endpoints (all `@RequireMunicipalityMember()`, service does `canManage`):
`GET|PUT|DELETE /api/gis/layers/:id/style`,
`GET /api/gis/layers/:id/style/{attributes,field-stats}`,
`POST /api/gis/layers/:id/style/icon`, `GET …/style/icon/:name`,
`GET /api/gis/style/icons[/:id]`, and the `uploads` equivalents (no
layer-style DELETE).

## 28. GIS Uploads (Task 7) — overview

Turns the Municipal GIS from a read-only viewer into a system where
authorized users upload real GIS data, which only ever reaches the live
map after passing through an explicit
`UPLOAD_PENDING → VALIDATING → DRAFT → IN_REVIEW → APPROVED → PUBLISHED`
gate (or `→ REJECTED` / `→ FAILED` / `→ PUBLISH_FAILED`). Uploaded data is
**never** live on the map until an Owner has approved and published it —
see §33 "Important architectural rule".

Supported formats: Shapefile ZIP (one dataset per upload — `.shp` +
`.shx` + `.dbf` required, `.prj`/`.cpg` optional), GeoJSON (`.geojson`/
`.json`), CSV with latitude/longitude or X/Y columns. Raster formats
(GeoTIFF/COG) are explicitly out of scope.

Everything about a single uploaded file lives in one `GISLayerUpload` row
(table `gis_layer_uploads`) — it never itself "is" a live layer.
Publishing creates or updates a separate `GISLayer` row; the live map
(`GET /api/gis/layers`, §22) only ever reads `GISLayer`, never
`GISLayerUpload`.

## 29. GDAL Configuration

GDAL/OGR (`ogrinfo`, `ogr2ogr`) is the only GIS processing engine used —
there is no hand-written Shapefile/GeoJSON/CSV parser anywhere in this
codebase (Task 7 §2). Every invocation goes through `GdalService`, using
`child_process.execFile` with arguments passed as an **array**, never a
shell string, so nothing in an uploaded filename or attribute value can
ever be interpreted as a shell command.

**Base image**: the backend's `Dockerfile` builds `FROM
ghcr.io/osgeo/gdal:alpine-normal-latest` (Node.js added via `apk add
nodejs npm`), not `node:22-alpine` + `apk add gdal`. This was a real
finding during Task 7 development: Alpine's own `gdal`/`gdal-tools`
community packages are built **without** a live PostgreSQL/PostGIS
vector driver (only `PGDUMP`, which writes a `.sql` file rather than
connecting), which `GdalService.importToPostgis` depends on — confirmed
via `ogr2ogr --formats`. The official OSGeo image bundles a GDAL build
with the full driver set, including a live `PostgreSQL` driver.

`GdalService.inspect()` runs `ogrinfo -json -al -so` and parses:
`driverShortName`, `layers[0].name/featureCount/fields`, and — critically
— `layers[0].geometryFields[0].coordinateSystem.projjson.id.{authority,code}`
for a numeric EPSG code (far more reliable than parsing WKT text). CSV
lat/lon or X/Y column selection is passed via `-oo
X_POSSIBLE_NAMES=...`/`-oo Y_POSSIBLE_NAMES=...`/`-oo
KEEP_GEOM_COLUMNS=NO`.

`GdalService.importToPostgis()` runs `ogr2ogr -f PostgreSQL "PG:..."
<source> -nln <table> -lco GEOMETRY_NAME=geom -lco PRECISION=NO -nlt
PROMOTE_TO_MULTI -t_srs <targetCrs> [-s_srs <override>] -overwrite`.
Table/column identifier quoting is handled internally by GDAL's
PostgreSQL driver — this, not any hand-written SQL, is what satisfies
Task 7 §10 ("do not directly use uploaded field names to construct SQL
without sanitization").

The FID column is left to GDAL's default (`ogc_fid`) — **not** forced to
`id`. Municipal shapefiles frequently carry their own `id` attribute
column (String/Real); `-lco FID=id` then makes ogr2ogr try to source the
FID from it and aborts the import with `ERROR 1: Wrong field type for
id`. With the default, that column imports as an ordinary attribute and
GeoServer still auto-detects the primary key.

## 30. CRS handling (Task 7)

Never trusts a `.prj`/embedded CRS blindly (§8): the resolved source CRS
for import is always one of, in priority order:

1. An explicit `sourceCrs` supplied by the caller (the wizard's own
   confirmation) — always wins, even over what GDAL auto-detected.
2. `EPSG:4326` for CSV latitude/longitude columns — the semantic
   definition of "latitude/longitude" makes this a safe default, unlike
   X/Y.
3. Whatever GDAL itself detected from the file (Shapefile `.prj`,
   GeoJSON `crs`), for Shapefile ZIP / GeoJSON only.

CSV **X/Y** columns never get a default — `sourceCrs` is required
whenever `xField`/`yField` are used (explicitly or auto-detected), else
the upload fails validation with a clear message asking for it (§8: "Do
not assume X/Y means WGS84"). If no CRS could be determined at all, the
upload is marked `FAILED` rather than silently proceeding.

Target CRS is always the destination `GISWorkspace.defaultCrs` — never
configurable per-upload.

## 31. Geometry validation

After import, `GisUploadsService` runs a single PostGIS query against the
new table:

```sql
SELECT
  count(*) FILTER (WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom) AND NOT ST_IsValid(geom)) AS invalid_count,
  count(*) FILTER (WHERE geom IS NULL OR ST_IsEmpty(geom)) AS empty_count
FROM "<table>"
```

Invalid/empty geometries are reported as **warnings** in
`validationSummary`, never as fatal errors, and are **never
auto-repaired** (§9) — e.g. no `ST_MakeValid`. A self-intersecting
polygon still reaches `DRAFT`, with the warning surfaced through the
whole pipeline (upload response → review screen → detail dialog).

## 32. PostGIS import & table naming

Every upload gets its own dedicated PostGIS table — never a shared one —
named `layer_<uuid-without-dashes>` (`layer-naming.util.ts
generateLayerTableName()`), **always** application-generated, never
derived from the layer name, filename, or any other user input (§28: "Do
not use `layer_<user_input>` directly"). Before any raw SQL touches a
table name (spatial index creation, geometry validation query, `DROP
TABLE` during a version swap), `isSafeGeneratedTableName()` re-validates
it against the exact expected shape (`^layer_[a-f0-9]{32}$`) as
defense-in-depth, even though the value only ever originates from our own
generator.

GDAL's PostgreSQL driver creates its own spatial index by default on
import; `GisUploadsService.ensureSpatialIndex()` additionally issues its
own `CREATE INDEX IF NOT EXISTS ... USING GIST ("geom")` and then queries
`pg_indexes` to positively confirm the index exists (§29's "verify") —
harmless if this duplicates GDAL's own index.

Import happens **once**, at validate time (as part of the same
synchronous `POST /api/gis/uploads` call), not re-run at publish time.
The "PostGIS import" step in Task 7 §27's pipeline is satisfied by this
same table being promoted/adopted at publish — re-running GDAL a second
time would risk producing different output than what was already
validated and previewed, so publish only ever does the GeoServer +
metadata steps against the table that already exists.

## 33. GeoServer publishing & layer versioning

**New layer**: `ensureFeatureType` publishes the upload's dedicated table
under a *friendly* name (`name` = lowercased `layerCode`, e.g.
`road_network`; `nativeName` = the actual `layer_<uuid>` table) — same
`name`/`nativeName` split Task 6 already established for the demo layers,
just without a `cqlFilter` (unnecessary: each layer already has a
physically separate table, so there's no shared-table row to filter).

**Replacing a published layer (a new version)**: uploading again under
the same layer name derives the same deterministic `layerCode` (§11), so
publishing it is a *replace*, not a duplicate. The old feature type and
table are only ever torn down **after** the new version's own feature
type has been successfully created — Task 7 §16's "must not destroy the
existing published version before the new version is successfully
validated and published" — verified live: the old version keeps serving
WMS correctly for the entire draft/review/approval window of the new
one, and only flips at the moment `publish` actually runs. `GISLayer`
itself keeps a stable `id`; only its `postgisTable`/`geoserverLayer`
pointers and `version` (incremented, never reset) change. A short window
where the layer is unavailable during the actual swap is an accepted,
documented simplification (§16 explicitly permits this).

**Preview** (§20/§52): a temporary feature type named
`preview_<uploadId>` is published under the SAME dedicated table,
reusing Task 6's `ImageWMS`/`MunicipalMapComponent` rendering exactly —
no separate preview infrastructure, no raw geometry ever sent to the
browser. Deleted (best-effort) once the real feature type takes over at
publish time.

**Deleting a layer**: `DELETE /api/gis/layers/:id`
(`GisLayersService.deleteLayer`) is a **hard delete**, **owner-only**
(re-checked in the service, and guarded by `@RequireMunicipalityOwner()`
— matching `DELETE /api/departments/:id`; it is *not* delegated through
the MANAGE permission the way permission editing is, because it discards
every version's data and all cross-department grants). Order:

1. read the upload history (`gISLayerUpload.findMany({ where: { layerId } })`)
   **before** any delete — the `GISLayer` delete nulls
   `gis_layer_uploads.layer_id` via the FK;
2. `deleteFeatureType` (recurse) — GeoServer first, so its failure aborts
   before any DB write and the delete stays retryable;
3. one transaction: `gISLayerUpload.deleteMany({ where: { layerId } })` +
   `gISLayer.delete` (its `GISLayerPermission` grants cascade). **Every
   upload that produced this layer — all versions — is removed**, so the
   GIS Data list never keeps showing an upload whose layer is gone.
   DRAFT / FAILED uploads that never produced this layer (`layerId` null)
   are left alone;
4. best-effort: `DROP TABLE IF EXISTS` every `layer_<uuid>` table (the
   layer's plus each deleted upload's own), then
   `StorageService.deleteUploadFiles` for each upload (raw + temporary
   dirs). Failures here only orphan a table/file, never break the list.

The shared `gis_demo_*` tables behind a CANONICAL/demo layer are never
dropped (`postgisTable` is null for those, and `isSafeGeneratedTableName`
is still checked defensively).

**Failure handling** (§38): every GeoServer call in `publish()` happens
BEFORE the Prisma transaction that writes `GISLayer`/marks the upload
`PUBLISHED` — a GeoServer failure leaves the upload `PUBLISH_FAILED`
with the error message stored, and (for a new layer) no `GISLayer` row
is ever created. Retrying is idempotent: `ensureFeatureType` checks
existence first, so a retry after GeoServer recovers publishes cleanly
with no duplicate feature type or `GISLayer` row — verified live by
stopping GeoServer mid-publish, confirming `PUBLISH_FAILED`, restarting
GeoServer, and retrying successfully.

## 34. File storage & security (Task 7 §34/§36)

```
<GIS_UPLOAD_STORAGE_DIR>/<municipalityId>/
  raw/<uploadId>/<uuid>.<ext>        — original file, retained after publish
  temporary/<uploadId>/...           — extracted ZIP contents, deleted once validation finishes with them
```

Every path is built from a server-derived `municipalityId` (never client
input, and defensively re-validated as UUID-shaped before use) — tenant
isolation at the filesystem level, not just the database. The original
uploaded filename is preserved only in `GISLayerUpload.originalFilename`
for display; the actual file on disk always gets an application-generated
name with a whitelisted extension (`.zip`/`.geojson`/`.json`/`.csv`,
anything else becomes `.bin`).

**ZIP extraction** (`StorageService.extractZipSafely`) validates every
entry before writing anything:
- rejects `../`/absolute-path entries (zip-slip) and symlink entries
  (checked via the entry's Unix mode bits in `header.attr`)
- rejects more than `GIS_UPLOAD_MAX_ZIP_FILE_COUNT` entries, or declared
  uncompressed size over `GIS_UPLOAD_MAX_EXTRACTED_ZIP_SIZE_MB` (a
  zip-bomb guard, checked against the archive's own declared sizes
  before any bytes are written)
- flattens output to basenames (Shapefile datasets are one flat sibling
  set, §5) and rejects two entries that collide once flattened
- the whole ZIP is rejected — nothing written — if any single entry
  fails a check; never a partial extraction

`docker-compose.yml`'s `backend-storage` named volume keeps these files
out of the host-owned bind mount, same reasoning as `backend-dist` (§2)
— the container runs as root and would otherwise leave root-owned files
under `./backend/storage`.

Upload size (`GIS_UPLOAD_MAX_FILE_SIZE_MB`, default 500) is enforced by
Multer's own `limits.fileSize` before the request body is even fully
buffered — verified live with a temporarily-lowered limit, rejected
cleanly with `413`.

## 35. Draft/review/publish workflow & authorization

| Action | MUNICIPALITY_USER | MUNICIPALITY_OWNER |
|---|---|---|
| Upload a DEPARTMENT layer to their own department | ✓ | ✓ (any department) |
| Upload a CANONICAL layer | ✗ | ✓ |
| View own/own-department uploads | ✓ | ✓ (all) |
| Validate/retry, submit for review (own upload only) | ✓ | ✓ |
| Approve / reject / publish | ✗ | ✓ |

Department ownership is always re-validated server-side
(`department.municipalityId === appUser.municipalityId`) — a
`departmentId` from another municipality 404s rather than confirming it
exists elsewhere (§41). Viewing an upload outside the caller's own
uploads/department (and outside another municipality entirely) also
404s, never 403 — consistent with every other tenant-scoped lookup in
this codebase.

## 36. Tests

```bash
cd backend
npm test              # unit tests (no infra required)
npm run test:e2e       # requires a reachable Postgres — see backend/.env.example
```

## 37. Known limitations (by design for these tasks)

- Editing/draw tools, spatial analysis, measurement, printing, raster
  processing (GeoTIFF/COG), vector tile infrastructure, Redis/BullMQ
  background workers, or 3D/Cesium — all explicitly out of scope for
  Task 7, later tasks. Upload processing is synchronous (Task 7 §3
  explicitly permits this for the initial implementation); `GdalService`/
  `GisUploadsService` are structured so the actual GDAL work could later
  move behind a queue without changing the public API shape.
- GeoServer's WMS/WFS OGC endpoints are public/anonymous; tenant
  isolation for Task 6's shared demo tables relies on per-municipality
  CQL filters, not authentication at the OGC layer (§23's "Known
  limitation") — Task 7 uploaded layers avoid this exposure entirely by
  giving each layer its own dedicated table instead of a shared one, but
  the underlying "OGC endpoints are public" constraint is unchanged.
- Layer-version replacement (§33) has a brief window where the layer is
  unavailable during the actual GeoServer swap — an accepted
  simplification Task 7 §16 explicitly permits.
- No background garbage collection for an abandoned upload's preview
  feature type/table (e.g. a DRAFT the uploader never submits or that
  gets rejected) — harmless clutter, not a security or correctness
  issue, but worth a cleanup job in a future task.
- User invitations or granular roles/permissions beyond Owner/User —
  later tasks.
- No full audit log (who changed what, when, previous value) — see §5.
  `createdById`/`updatedById` + `createdAt`/`updatedAt` (and, for
  uploads, `reviewedBy`/`reviewedAt`/`publishedBy`/`publishedAt`) only.
- `POST /api/municipalities/register`, `POST /api/users`, and `POST
  /api/gis/uploads` have no rate limiting — acceptable for this task's
  scope, worth revisiting alongside broader abuse protection.
- Cross-tenant isolation is enforced in application code (every query is
  scoped by the authenticated user's `municipality_id`), not via
  PostgreSQL row-level security. RLS is a future hardening task.
- Owner-created users get a temporary password returned once in the API
  response, with no email delivery — see §10.
- Deactivating a user does not disable their Keycloak account, only revokes
  sessions + blocks this API — see §9.
- GeoServer's data directory is a named Docker volume (`geoserver-data`),
  not backed up anywhere — fine for local dev, would need real backup
  strategy before any shared/production environment.
- No automatic per-state/region CRS selection or CRS auto-detection from
  data (§18/§30) beyond what's described above.
