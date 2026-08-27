import { MunicipalitiesController } from './municipalities.controller';
import { MunicipalitiesService } from './municipalities.service';
import type { KeycloakJwtPayload } from '../auth/strategies/keycloak-jwt.strategy';

/**
 * Security test for Task 3 §14: User A belongs to Municipality A, User B
 * belongs to Municipality B. User A must never be able to read Municipality
 * B's data by changing `municipalityId` in the request — because the
 * tenant is derived exclusively from the authenticated Keycloak identity
 * (JWT `sub`), and any client-supplied municipality id is ignored.
 */
describe('Cross-municipality access (tenant isolation)', () => {
  const userAJwt = { sub: 'keycloak-user-a' } as KeycloakJwtPayload;
  const userBJwt = { sub: 'keycloak-user-b' } as KeycloakJwtPayload;

  const municipalityByKeycloakId: Record<string, { id: string; name: string }> =
    {
      'keycloak-user-a': { id: 'municipality-a', name: 'Municipality A' },
      'keycloak-user-b': { id: 'municipality-b', name: 'Municipality B' },
    };

  function buildController() {
    const service = {
      getMunicipalityForKeycloakUser: jest.fn((keycloakUserId: string) =>
        Promise.resolve(municipalityByKeycloakId[keycloakUserId]),
      ),
    };
    const controller = new MunicipalitiesController(
      service as unknown as MunicipalitiesService,
    );
    return { controller, service };
  }

  it("returns User A's own municipality when no tenant override is supplied", async () => {
    const { controller } = buildController();

    const result = await controller.getCurrentMunicipality(userAJwt, undefined);

    expect(result.id).toBe('municipality-a');
  });

  it("ignores an attacker-supplied municipalityId and still returns only User A's municipality", async () => {
    const { controller, service } = buildController();

    // Simulates User A's authenticated request, but with the query string
    // tampered to request Municipality B's id — as if the browser sent
    // `GET /api/municipalities/current?municipalityId=municipality-b`.
    const result = await controller.getCurrentMunicipality(
      userAJwt,
      'municipality-b',
    );

    expect(result.id).toBe('municipality-a');
    expect(result.id).not.toBe('municipality-b');
    // The service is only ever invoked with the identity from the JWT —
    // the tampered query value is never passed through to data access.
    expect(service.getMunicipalityForKeycloakUser).toHaveBeenCalledWith(
      'keycloak-user-a',
    );
    expect(service.getMunicipalityForKeycloakUser).not.toHaveBeenCalledWith(
      'municipality-b',
    );
  });

  it("keeps User B's access confined to Municipality B under the same attack", async () => {
    const { controller } = buildController();

    const result = await controller.getCurrentMunicipality(
      userBJwt,
      'municipality-a',
    );

    expect(result.id).toBe('municipality-b');
  });
});
