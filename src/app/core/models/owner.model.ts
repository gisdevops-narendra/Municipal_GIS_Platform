/** The Municipality Owner is always the first user created during
 *  registration. Role is assigned automatically by the system — it is
 *  never a field the user selects. */
export interface OwnerAccountInfo {
  fullName: string;
  officialEmail: string;
  mobileNumber: string;
  password: string;
  confirmPassword: string;
}

export const emptyOwnerAccountInfo: OwnerAccountInfo = {
  fullName: '',
  officialEmail: '',
  mobileNumber: '',
  password: '',
  confirmPassword: ''
};

export const MUNICIPALITY_OWNER_ROLE = 'MUNICIPALITY_OWNER' as const;
