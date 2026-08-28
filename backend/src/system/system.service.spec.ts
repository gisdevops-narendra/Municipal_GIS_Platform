import { SystemService } from './system.service';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from '../gis/geoserver.service';
import { ConfigService } from '@nestjs/config';

describe('SystemService', () => {
  const config = {
    get: (key: string) => (key === 'NODE_ENV' ? 'test' : undefined),
  } as unknown as ConfigService;

  function build(over: { queryRaw?: jest.Mock; checkHealth?: jest.Mock }) {
    const prisma = {
      $queryRaw: over.queryRaw ?? jest.fn().mockResolvedValue([{ v: '3.4.2' }]),
    } as unknown as PrismaService;
    const geo = {
      checkHealth:
        over.checkHealth ??
        jest.fn().mockResolvedValue({ reachable: true, version: '2.25.2' }),
    } as unknown as GeoServerService;
    return new SystemService(prisma, geo, config);
  }

  it('reports every component up when all checks pass', async () => {
    const status = await build({}).status();
    expect(status.api.status).toBe('up');
    expect(status.database.status).toBe('up');
    expect(status.postgis.status).toBe('up');
    expect(status.postgis.version).toBe('3.4.2');
    expect(status.geoserver.status).toBe('up');
  });

  it('a failing dependency still resolves (down, not thrown)', async () => {
    const status = await build({
      queryRaw: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      checkHealth: jest
        .fn()
        .mockResolvedValue({ reachable: false, message: 'timeout' }),
    }).status();

    expect(status.api.status).toBe('up');
    expect(status.database.status).toBe('down');
    expect(status.postgis.status).toBe('down');
    expect(status.geoserver.status).toBe('down');
    expect(status.geoserver.detail).toBe('timeout');
  });

  it('info exposes node + environment', () => {
    const info = build({}).info();
    expect(info.node).toBe(process.version);
    expect(info.environment).toBe('test');
  });
});
