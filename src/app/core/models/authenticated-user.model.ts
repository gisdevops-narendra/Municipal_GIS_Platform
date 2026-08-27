/**
 * Basic identity information exposed to the application after a successful
 * Keycloak login. Sourced from the ID/access token claims — never treat this
 * as authorization data. Municipality/department/role/permission modelling
 * is a separate, later concern (see AuthService for details).
 */
export interface AuthenticatedUser {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}
