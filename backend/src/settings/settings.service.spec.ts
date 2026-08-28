import { SettingsService } from './settings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AppSettingsDto } from './dto/app-settings.dto';

describe('SettingsService', () => {
  let service: SettingsService;
  let userSetting: {
    findUnique: jest.Mock;
    upsert: jest.Mock;
    deleteMany: jest.Mock;
  };

  beforeEach(() => {
    userSetting = {
      findUnique: jest.fn(),
      upsert: jest.fn().mockResolvedValue(undefined),
      deleteMany: jest.fn().mockResolvedValue(undefined),
    };
    service = new SettingsService({ userSetting } as unknown as PrismaService);
  });

  it('get returns {} when the user has no row yet', async () => {
    userSetting.findUnique.mockResolvedValue(null);
    await expect(service.get('u1')).resolves.toEqual({
      settings: {},
      updatedAt: null,
    });
  });

  it('patch deep-merges into the stored blob (nested keys preserved)', async () => {
    userSetting.findUnique.mockResolvedValue({
      data: {
        appearance: { theme: 'light', density: 'comfortable' },
        map: { units: 'metric' },
      },
    });

    const merged = await service.patch('u1', {
      appearance: { theme: 'dark' },
    });

    expect(merged).toEqual({
      appearance: { theme: 'dark', density: 'comfortable' },
      map: { units: 'metric' },
    });
    expect(userSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: 'u1' } }),
    );
  });

  it('patch treats null as a real value (clears a nested object)', async () => {
    userSetting.findUnique.mockResolvedValue({
      data: { map: { defaultView: { lon: 1, lat: 2, zoom: 3 } } },
    });
    const merged = await service.patch('u1', {
      map: { defaultView: null },
    });
    expect(merged).toEqual({ map: { defaultView: null } });
  });

  it('reset deletes the row', async () => {
    await service.reset('u1');
    expect(userSetting.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
    });
  });
});
