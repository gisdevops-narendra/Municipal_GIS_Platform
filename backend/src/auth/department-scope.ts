import type { AppUser } from './types/app-user.type';

/**
 * Which department a caller may see for organizational reads (departments,
 * users, dashboard department counts):
 *
 *  - `undefined` — unrestricted; the MUNICIPALITY_OWNER sees every
 *    department of their municipality.
 *  - a department id — DEPARTMENT_HEAD/DEPARTMENT_USER are confined to
 *    their own department.
 *  - `null` — a non-owner with no department assigned sees nothing.
 *
 * Like `municipalityId`, this is always derived from the trusted AppUser,
 * never from client input.
 */
export type DepartmentScope = string | null | undefined;

export function departmentScopeOf(appUser: AppUser): DepartmentScope {
  return appUser.systemRole === 'MUNICIPALITY_OWNER'
    ? undefined
    : appUser.departmentId;
}
