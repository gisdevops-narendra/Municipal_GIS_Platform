import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { GeoServerService } from '../gis/geoserver.service';

export type ComponentState = 'up' | 'down';

export interface ComponentStatus {
  status: ComponentState;
  detail?: string;
  version?: string;
  latencyMs?: number;
}

export interface SystemStatus {
  checkedAt: string;
  api: ComponentStatus;
  database: ComponentStatus;
  postgis: ComponentStatus;
  geoserver: ComponentStatus;
}

/**
 * Read-only connectivity + version reporting for the Settings → System
 * Status screen. Every check is defensive: a dependency being down is a
 * normal payload (`status: 'down'`), never a thrown error, so one broken
 * component never hides the health of the others.
 */
@Injectable()
export class SystemService {
  private readonly startedAt = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly geoServer: GeoServerService,
    private readonly config: ConfigService,
  ) {}

  async status(): Promise<SystemStatus> {
    const [database, postgis, geoserver] = await Promise.all([
      this.checkDatabase(),
      this.checkPostgis(),
      this.checkGeoServer(),
    ]);
    return {
      checkedAt: new Date().toISOString(),
      api: {
        status: 'up',
        detail: `Uptime ${this.uptimeLabel()}`,
      },
      database,
      postgis,
      geoserver,
    };
  }

  info() {
    return {
      apiVersion: this.config.get<string>('npm_package_version') ?? '0.0.1',
      node: process.version,
      environment: this.config.get<string>('NODE_ENV') ?? 'development',
      startedAt: this.startedAt.toISOString(),
    };
  }

  private async checkDatabase(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'up', latencyMs: Date.now() - started };
    } catch (error) {
      return { status: 'down', detail: (error as Error).message };
    }
  }

  private async checkPostgis(): Promise<ComponentStatus> {
    const started = Date.now();
    try {
      const rows = await this.prisma.$queryRaw<{ v: string }[]>`
        SELECT PostGIS_Lib_Version() AS v
      `;
      return {
        status: 'up',
        version: rows[0]?.v,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return { status: 'down', detail: (error as Error).message };
    }
  }

  private async checkGeoServer(): Promise<ComponentStatus> {
    const started = Date.now();
    const health = await this.geoServer.checkHealth();
    return health.reachable
      ? {
          status: 'up',
          version: health.version,
          latencyMs: Date.now() - started,
        }
      : { status: 'down', detail: health.message ?? 'Unreachable' };
  }

  private uptimeLabel(): string {
    const seconds = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
  }
}
