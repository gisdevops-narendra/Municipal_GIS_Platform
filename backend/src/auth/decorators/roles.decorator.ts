import { SetMetadata } from '@nestjs/common';
import type { SystemRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/** Declares which SystemRole(s) may access a route. Enforced by RolesGuard,
 *  which reads `request.appUser` (set by AppUserGuard) — always combine
 *  with `@UseGuards(KeycloakJwtGuard, AppUserGuard, RolesGuard)`, or use
 *  the `RequireMunicipalityOwner()` convenience decorator instead. */
export const Roles = (...roles: SystemRole[]) => SetMetadata(ROLES_KEY, roles);
