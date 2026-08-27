/** Request body for POST /api/municipalities/register. Deliberately has no
 *  `role` or `keycloakUserId` field — the backend assigns those; the
 *  browser can never supply them. */
export interface RegisterMunicipalityRequest {
  municipality: {
    name: string;
    type: string;
    state: string;
    district: string;
    city: string;
    officialEmail: string;
    contactNumber: string;
  };
  owner: {
    fullName: string;
    email: string;
    mobileNumber: string;
    /** Forwarded once to Keycloak by the backend; never logged or stored
     *  by this service beyond the single request. */
    password: string;
  };
}

export interface RegisterMunicipalityResponse {
  municipality: {
    id: string;
    name: string;
    type: string;
    state: string;
    district: string;
    city: string;
    officialEmail: string;
    contactNumber: string;
    status: string;
  };
  owner: {
    id: string;
    fullName: string;
    email: string;
    systemRole: 'MUNICIPALITY_OWNER';
  };
}
