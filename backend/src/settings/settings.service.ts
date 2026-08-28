import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { AppSettingsDto } from './dto/app-settings.dto';

type Json = Record<string, unknown>;

/**
 * Per-user settings storage. No defaults live here — the frontend owns the
 * default set and merges the stored (partial) blob over it. This service
 * just persists exactly what it is given, validated by `AppSettingsDto`.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    userId: string,
  ): Promise<{ settings: Json; updatedAt: string | null }> {
    const row = await this.prisma.userSetting.findUnique({ where: { userId } });
    return {
      settings: (row?.data as Json) ?? {},
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  /** Deep-merges `partial` into the stored blob and returns the result. */
  async patch(userId: string, partial: AppSettingsDto): Promise<Json> {
    const current = await this.prisma.userSetting.findUnique({
      where: { userId },
    });
    const merged = deepMerge(
      (current?.data as Json) ?? {},
      partial as unknown as Json,
    );
    const data = merged as Prisma.InputJsonValue;
    await this.prisma.userSetting.upsert({
      where: { userId },
      create: { userId, data },
      update: { data },
    });
    return merged;
  }

  /** "Reset Application Settings" — drops the row entirely. */
  async reset(userId: string): Promise<void> {
    await this.prisma.userSetting.deleteMany({ where: { userId } });
  }
}

/**
 * Recursive merge: plain objects merge key-by-key; every other value
 * (primitive, array, `null`) from `source` replaces `target`. `null` is a
 * deliberate value here (e.g. `map.defaultView: null` clears a saved view).
 */
function deepMerge(target: Json, source: Json): Json {
  const out: Json = { ...target };
  for (const [key, value] of Object.entries(source)) {
    const existing = out[key];
    if (isPlainObject(value) && isPlainObject(existing)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
