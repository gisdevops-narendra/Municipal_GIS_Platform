/** Shape of GET /api/me — the authenticated application user, resolved
 *  server-side from the validated Keycloak JWT. Never constructed from
 *  local/Keycloak-only data; always fetched from the backend. */
export interface CurrentUser {
  id: string;
  keycloakUserId: string;
  name: string;
  email: string;
  mobileNumber: string;
  /** Task 8: exactly three roles — no GIS_VIEWER or any other role. */
  systemRole: 'MUNICIPALITY_OWNER' | 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';
  status: 'ACTIVE' | 'DISABLED';
  /** Platform administrator (sees /admin). */
  isPlatformAdmin?: boolean;
  municipality: {
    id: string;
    name: string;
    type: string;
    state: string;
    district: string;
    city: string;
  };
}
