import { applyDecorators, UseGuards } from '@nestjs/common';
import { KeycloakJwtGuard } from '../guards/keycloak-jwt.guard';
import { AppUserGuard } from '../guards/app-user.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from './roles.decorator';

/**
 * Any authenticated, active member of a municipality — all three roles
 * (MUNICIPALITY_OWNER, DEPARTMENT_HEAD, DEPARTMENT_USER — Task 8). Use for
 * read endpoints that any signed-in member of the tenant may call (e.g.
 * listing departments). Populates `request.appUser` for
 * `@CurrentAppUser()`. Note: as of Task 8, GIS layer actions (upload/
 * approve/publish/export/manage) use this decorator too, with the real
 * gate enforced by GisAuthorizationService inside the service layer, not
 * by role alone — see docs/backend.md "GIS Layer Permissions".
 */
export function RequireMunicipalityMember() {
  return UseGuards(KeycloakJwtGuard, AppUserGuard);
}

/**
 * MUNICIPALITY_OWNER or DEPARTMENT_HEAD. A DEPARTMENT_USER may only view
 * the municipal GIS map, so the organizational/management reads behind the
 * other screens (departments, users, GIS uploads, dashboard summaries)
 * answer them with a clean 403 — see RolesGuard.
 */
export function RequireMunicipalityManager() {
  return applyDecorators(
    UseGuards(KeycloakJwtGuard, AppUserGuard, RolesGuard),
    Roles('MUNICIPALITY_OWNER', 'DEPARTMENT_HEAD'),
  );
}

/**
 * MUNICIPALITY_OWNER only. Use for administration endpoints (create/update/
 * deactivate departments and users). A DEPARTMENT_HEAD or DEPARTMENT_USER
 * hitting one of these gets a clean 403 — see RolesGuard.
 */
export function RequireMunicipalityOwner() {
  return applyDecorators(
    UseGuards(KeycloakJwtGuard, AppUserGuard, RolesGuard),
    Roles('MUNICIPALITY_OWNER'),
  );
}
