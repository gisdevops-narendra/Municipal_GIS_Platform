import { ALL_PERMISSIONS, GisAuthorizationService } from './gis-authorization.service';
import type { AppUser } from '../auth/types/app-user.type';

/** Departments and per-layer grants were removed: an active account owner
 *  may do everything with their own account's layers; a disabled one
 *  nothing. (Tenant isolation is the callers' job and is tested there.) */
describe('GisAuthorizationService', () => {
  const service = new GisAuthorizationService();
  const active: AppUser = {
    id: 'u1',
    keycloakUserId: 'kc-1',
    municipalityId: 'acct-1',
    systemRole: 'MUNICIPALITY_OWNER',
    status: 'ACTIVE',
  };
  const disabled: AppUser = { ...active, status: 'DISABLED' };
  const layer = { id: 'layer-1' };

  it('gives an active user every permission on their layers', async () => {
    expect([...(await service.getPermissions(active, layer))].sort()).toEqual([...ALL_PERMISSIONS].sort());
    await expect(service.canView(active, layer)).resolves.toBe(true);
    await expect(service.canUpload(active, layer)).resolves.toBe(true);
    await expect(service.canExport(active, layer)).resolves.toBe(true);
    await expect(service.canManage(active, layer)).resolves.toBe(true);
  });

  it('gives the same permissions for a layer that does not exist yet', () => {
    expect(service.getDefaultPermissions(active).has('UPLOAD')).toBe(true);
  });

  it('gives a disabled user nothing', async () => {
    expect((await service.getPermissions(disabled, layer)).size).toBe(0);
    await expect(service.canView(disabled, layer)).resolves.toBe(false);
    expect(service.getDefaultPermissions(disabled).size).toBe(0);
  });

  it('passes an already account-scoped layer list through unchanged', async () => {
    const layers = [{ id: 'a' }, { id: 'b' }];
    await expect(service.filterViewable(active, layers)).resolves.toBe(layers);
  });
});
