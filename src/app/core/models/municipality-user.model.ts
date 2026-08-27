/** A user within the authenticated caller's own municipality, as returned
 *  by the /api/users endpoints. Distinct from CurrentUser (which is the
 *  caller's own /api/me profile). Task 8: exactly three roles — no
 *  GIS_VIEWER or any other role. */
export type SystemRole = 'MUNICIPALITY_OWNER' | 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';
export type ManagedRole = 'DEPARTMENT_HEAD' | 'DEPARTMENT_USER';
export type MunicipalityUserStatus = 'ACTIVE' | 'DISABLED';

export interface MunicipalityUser {
  id: string;
  fullName: string;
  email: string;
  mobileNumber: string;
  systemRole: SystemRole;
  status: MunicipalityUserStatus;
  department: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** `role` defaults to DEPARTMENT_USER server-side when omitted —
 *  MUNICIPALITY_OWNER is never accepted here. */
export interface CreateMunicipalityUserRequest {
  fullName: string;
  email: string;
  mobileNumber: string;
  departmentId?: string;
  role?: ManagedRole;
}

export interface CreateMunicipalityUserResponse {
  user: MunicipalityUser;
  /** Shown to the Owner exactly once — there is no email/invite delivery
   *  in this task's scope, so the Owner must share it out of band. */
  temporaryPassword: string;
}

export interface UpdateMunicipalityUserRequest {
  fullName?: string;
  mobileNumber?: string;
  departmentId?: string | null;
  role?: ManagedRole;
}
