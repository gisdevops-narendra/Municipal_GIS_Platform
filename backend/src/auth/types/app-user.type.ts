import type { SystemRole, UserStatus } from '@prisma/client';

/**
 * Minimal, trusted view of the authenticated application user, resolved
 * server-side by AppUserGuard from the validated Keycloak identity — never
 * from anything the client supplies. This is the single source of truth
 * for "which municipality/department/role does this request act as".
 */
export interface AppUser {
  id: string;
  keycloakUserId: string;
  municipalityId: string;
  departmentId: string | null;
  systemRole: SystemRole;
  status: UserStatus;
}
