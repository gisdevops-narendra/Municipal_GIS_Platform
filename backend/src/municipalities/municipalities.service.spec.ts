import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MunicipalitiesService } from './municipalities.service';
import { PrismaService } from '../prisma/prisma.service';
import { KeycloakAdminService } from '../keycloak/keycloak-admin.service';
import { GisWorkspaceService } from '../gis/gis-workspace.service';
import { RegisterMunicipalityDto } from './dto/register-municipality.dto';

describe('MunicipalitiesService', () => {
  let service: MunicipalitiesService;
  let prisma: {
    municipality: { findUnique: jest.Mock };
    user: { findUnique: jest.Mock };
    $transaction: jest.Mock;
  };
  let keycloakAdmin: { createUser: jest.Mock; deleteUser: jest.Mock };
  let gisWorkspace: {
    createWorkspaceRecord: jest.Mock;
    provisionWorkspace: jest.Mock;
  };

  const dto: RegisterMunicipalityDto = {
    municipality: {
      name: 'Somnath Municipality',
      type: 'municipality',
      state: 'Gujarat',
      district: 'Gir Somnath',
      city: 'Somnath',
      officialEmail: 'owner@somnath.gov.in',
      contactNumber: '9876543210',
    },
    owner: {
      fullName: 'Narendra Owner',
      email: 'owner@somnath.gov.in',
      mobileNumber: '9876543210',
      password: 'Str0ng-Passw0rd',
    },
  };

  beforeEach(() => {
    prisma = {
      municipality: { findUnique: jest.fn() },
      user: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    keycloakAdmin = { createUser: jest.fn(), deleteUser: jest.fn() };
    gisWorkspace = {
      createWorkspaceRecord: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Somnath Municipality GIS',
        code: 'SOMNATH_MUNICIPALITY_GIS',
        geoserverWorkspace: 'somnath_municipality',
        status: 'PROVISIONING',
      }),
      provisionWorkspace: jest.fn().mockResolvedValue({
        id: 'workspace-1',
        name: 'Somnath Municipality GIS',
        code: 'SOMNATH_MUNICIPALITY_GIS',
        geoserverWorkspace: 'somnath_municipality',
        status: 'ACTIVE',
      }),
    };

    service = new MunicipalitiesService(
      prisma as unknown as PrismaService,
      keycloakAdmin as unknown as KeycloakAdminService,
      gisWorkspace as unknown as GisWorkspaceService,
    );
  });

  describe('registerMunicipality', () => {
    it('creates the Keycloak user and, in one transaction, the Municipality, an owner forced to MUNICIPALITY_OWNER, and the GIS workspace record — then provisions GeoServer', async () => {
      prisma.municipality.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      keycloakAdmin.createUser.mockResolvedValue({
        keycloakUserId: 'kc-owner-1',
      });

      let capturedUserCreateData: Record<string, unknown> | undefined;
      let capturedTx: unknown;
      prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => {
        const tx = {
          municipality: {
            create: jest.fn().mockResolvedValue({
              id: 'muni-1',
              ...dto.municipality,
              status: 'ACTIVE',
            }),
          },
          user: {
            create: jest
              .fn()
              .mockImplementation(
                ({ data }: { data: Record<string, unknown> }) => {
                  capturedUserCreateData = data;
                  return Promise.resolve({ id: 'user-1', ...data });
                },
              ),
          },
        };
        capturedTx = tx;
        return Promise.resolve(fn(tx));
      });

      const result = await service.registerMunicipality(dto);

      expect(keycloakAdmin.createUser).toHaveBeenCalledWith({
        email: dto.owner.email,
        fullName: dto.owner.fullName,
        mobileNumber: dto.owner.mobileNumber,
        password: dto.owner.password,
      });
      expect(capturedUserCreateData?.systemRole).toBe('MUNICIPALITY_OWNER');
      expect(capturedUserCreateData?.municipalityId).toBe('muni-1');
      expect(capturedUserCreateData?.keycloakUserId).toBe('kc-owner-1');
      expect(result.owner.systemRole).toBe('MUNICIPALITY_OWNER');
      expect(keycloakAdmin.deleteUser).not.toHaveBeenCalled();

      // GIS workspace record created inside the same transaction (same tx
      // client passed through), then provisioned only after it committed.
      expect(gisWorkspace.createWorkspaceRecord).toHaveBeenCalledWith(
        capturedTx,
        'muni-1',
        dto.municipality.name,
        'user-1',
      );
      expect(gisWorkspace.provisionWorkspace).toHaveBeenCalledWith(
        'workspace-1',
      );
      expect(result.gisWorkspace.status).toBe('ACTIVE');
      expect(result.gisWorkspace.geoserverWorkspace).toBe(
        'somnath_municipality',
      );
    });

    it('rejects a duplicate municipality email before ever calling Keycloak', async () => {
      prisma.municipality.findUnique.mockResolvedValue({ id: 'existing-muni' });
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.registerMunicipality(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(keycloakAdmin.createUser).not.toHaveBeenCalled();
    });

    it('rolls back the Keycloak user if the database transaction fails, without attempting GeoServer provisioning', async () => {
      prisma.municipality.findUnique.mockResolvedValue(null);
      prisma.user.findUnique.mockResolvedValue(null);
      keycloakAdmin.createUser.mockResolvedValue({
        keycloakUserId: 'kc-owner-2',
      });

      const dbError = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '6.19.3',
        },
      );
      prisma.$transaction.mockRejectedValue(dbError);

      await expect(service.registerMunicipality(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(keycloakAdmin.deleteUser).toHaveBeenCalledWith('kc-owner-2');
      expect(gisWorkspace.provisionWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('getMunicipalityForKeycloakUser (tenant isolation)', () => {
    it("returns only the caller's own municipality, keyed solely by their Keycloak identity", async () => {
      prisma.user.findUnique.mockImplementation(
        ({ where }: { where: { keycloakUserId: string } }) => {
          const byKeycloakId: Record<
            string,
            { municipality: Record<string, string> }
          > = {
            'keycloak-user-a': {
              municipality: {
                id: 'municipality-a',
                name: 'Municipality A',
                type: 'municipality',
                state: 'S',
                district: 'D',
                city: 'C',
              },
            },
            'keycloak-user-b': {
              municipality: {
                id: 'municipality-b',
                name: 'Municipality B',
                type: 'municipality',
                state: 'S',
                district: 'D',
                city: 'C',
              },
            },
          };
          return Promise.resolve(byKeycloakId[where.keycloakUserId] ?? null);
        },
      );

      const resultA =
        await service.getMunicipalityForKeycloakUser('keycloak-user-a');
      const resultB =
        await service.getMunicipalityForKeycloakUser('keycloak-user-b');

      expect(resultA.id).toBe('municipality-a');
      expect(resultB.id).toBe('municipality-b');
    });

    it('throws NotFoundException rather than leaking data when no application user is linked', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.getMunicipalityForKeycloakUser('unknown-keycloak-id'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
