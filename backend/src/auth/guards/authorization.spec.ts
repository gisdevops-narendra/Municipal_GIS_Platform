import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppUserGuard } from './app-user.guard';
import { RolesGuard } from './roles.guard';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Security tests for Task 4 §16/§21: MUNICIPALITY_OWNER-only administration
 * endpoints, and §11: a deactivated user must be rejected on every
 * subsequent API call regardless of their still-valid JWT.
 */
describe('AppUserGuard', () => {
  let prisma: { user: { findUnique: jest.Mock } };
  let guard: AppUserGuard;

  function buildContext(user: { sub: string } | undefined): {
    context: ExecutionContext;
    request: Record<string, unknown>;
  } {
    const request: Record<string, unknown> = { user };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, request };
  }

  beforeEach(() => {
    prisma = { user: { findUnique: jest.fn() } };
    guard = new AppUserGuard(prisma as unknown as PrismaService);
  });

  it('rejects when no Keycloak identity is present on the request', async () => {
    const { context } = buildContext(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects with 404 when the Keycloak identity has no linked application user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const { context } = buildContext({ sub: 'kc-unknown' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a DISABLED application user even with a cryptographically valid token', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      keycloakUserId: 'kc-1',
      municipalityId: 'muni-1',
      departmentId: null,
      systemRole: 'MUNICIPALITY_USER',
      status: 'DISABLED',
    });

    const { context } = buildContext({ sub: 'kc-1' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('attaches request.appUser and allows an ACTIVE user through', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      keycloakUserId: 'kc-1',
      municipalityId: 'muni-1',
      departmentId: 'dept-1',
      systemRole: 'MUNICIPALITY_OWNER',
      status: 'ACTIVE',
    });
    const { context, request } = buildContext({ sub: 'kc-1' });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect((request.appUser as { municipalityId: string }).municipalityId).toBe(
      'muni-1',
    );
  });
});

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  function buildContext(
    appUser: { systemRole: string } | undefined,
  ): ExecutionContext {
    const request: Record<string, unknown> = { appUser };
    return {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext;
  }

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  it('allows the request through when no @Roles(...) metadata is present', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(
      guard.canActivate(buildContext({ systemRole: 'MUNICIPALITY_USER' })),
    ).toBe(true);
  });

  it('rejects MUNICIPALITY_USER from an endpoint requiring MUNICIPALITY_OWNER', () => {
    reflector.getAllAndOverride.mockReturnValue(['MUNICIPALITY_OWNER']);

    expect(() =>
      guard.canActivate(buildContext({ systemRole: 'MUNICIPALITY_USER' })),
    ).toThrow(ForbiddenException);
  });

  it('allows MUNICIPALITY_OWNER through an endpoint requiring MUNICIPALITY_OWNER', () => {
    reflector.getAllAndOverride.mockReturnValue(['MUNICIPALITY_OWNER']);

    expect(
      guard.canActivate(buildContext({ systemRole: 'MUNICIPALITY_OWNER' })),
    ).toBe(true);
  });
});
