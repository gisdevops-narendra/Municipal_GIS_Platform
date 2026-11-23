import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface Branding {
  platformName: string;
  tagline: string;
  loginMessage: string;
  primaryColor: string | null;
  /** an uploaded logo exists (served at /api/platform/logo) */
  hasLogo: boolean;
  logoVersion: number;
}

export interface Announcement {
  enabled: boolean;
  message: string;
  level: 'info' | 'warning' | 'critical';
  /** ISO; null = no end */
  endsAt: string | null;
}

export interface Maintenance {
  enabled: boolean;
  message: string;
}

export interface ModuleSwitches {
  /** tool ids switched off for everyone */
  global: string[];
  /** tool ids switched off per account (municipality id) */
  perAccount: Record<string, string[]>;
}

export interface EmailSettings {
  host: string;
  port: number;
  from: string;
  fromName: string;
  /** STARTTLS / SSL as Keycloak understands it */
  starttls: boolean;
  ssl: boolean;
  auth: boolean;
  user: string;
  /** never returned to the browser once saved */
  password?: string;
}

export const DEFAULTS = {
  branding: { platformName: 'Municipal GIS', tagline: 'GIS platform for municipalities', loginMessage: '', primaryColor: null, hasLogo: false, logoVersion: 0 } as Branding,
  announcement: { enabled: false, message: '', level: 'info', endsAt: null } as Announcement,
  maintenance: { enabled: false, message: 'The platform is being updated. Please try again shortly.' } as Maintenance,
  modules: { global: [], perAccount: {} } as ModuleSwitches,
  email: { host: 'mailpit', port: 1025, from: 'no-reply@municipal-gis.local', fromName: 'Municipal GIS Platform', starttls: false, ssl: false, auth: false, user: '' } as EmailSettings,
};
type Key = keyof typeof DEFAULTS;

/** Platform-wide settings (one JSON value per key), cached briefly — the
 *  maintenance flag is read on every authenticated request. */
@Injectable()
export class PlatformSettingsService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends Key>(key: K): Promise<(typeof DEFAULTS)[K]> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 15_000) return hit.value as (typeof DEFAULTS)[K];
    const row = await this.prisma.platformSetting.findUnique({ where: { key } }).catch(() => null);
    const value = { ...DEFAULTS[key], ...((row?.value as object) ?? {}) } as (typeof DEFAULTS)[K];
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async set<K extends Key>(key: K, value: (typeof DEFAULTS)[K]): Promise<(typeof DEFAULTS)[K]> {
    const json = value as unknown as Prisma.InputJsonValue;
    await this.prisma.platformSetting.upsert({ where: { key }, create: { key, value: json }, update: { value: json } });
    this.cache.delete(key);
    return this.get(key);
  }
}
