import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import type { AppUser } from '../auth/types/app-user.type';
import { assertPublicUrl, safeFetch } from '../common/safe-fetch';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateApiKeyDto, CreateWebhookDto, UpdateWebhookDto, WebhookEvent } from './dto/platform-extras.dto';

const KEY_PREFIX = 'mgp_';
const RETRY_DELAYS_MS = [0, 5_000, 30_000];
const LAST_USED_WRITE_MS = 60_000;

export const hashApiKey = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * API keys (for outside systems calling the read-only API) and webhooks
 * (signed HTTP callbacks when data changes). Owner-managed.
 */
@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly lastUsedWritten = new Map<string, number>();

  constructor(private readonly prisma: PrismaService) {}

  // ----- API keys -----

  async listKeys(appUser: AppUser) {
    const rows = await this.prisma.apiKey.findMany({
      where: { municipalityId: appUser.municipalityId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ keyHash: _hash, ...row }) => ({ ...row, expired: !!row.expiresAt && row.expiresAt < new Date() }));
  }

  /** The full key is returned once, here; only its hash is stored. */
  async createKey(appUser: AppUser, dto: CreateApiKeyDto) {
    const secret = randomBytes(24).toString('base64url');
    const key = `${KEY_PREFIX}${secret}`;
    const row = await this.prisma.apiKey.create({
      data: {
        municipalityId: appUser.municipalityId,
        name: dto.name.trim(),
        prefix: key.slice(0, 12),
        keyHash: hashApiKey(key),
        createdById: appUser.id,
        expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
      },
    });
    const { keyHash: _hash, ...view } = row;
    return { ...view, key };
  }

  async revokeKey(appUser: AppUser, id: string) {
    const { count } = await this.prisma.apiKey.updateMany({
      where: { id, municipalityId: appUser.municipalityId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!count) throw new NotFoundException('API key not found.');
  }

  /** Resolves a presented key to the user it acts as, or null. */
  async resolveKey(key: string) {
    if (!key.startsWith(KEY_PREFIX)) return null;
    const row = await this.prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) } });
    if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) return null;
    const user = await this.prisma.user.findUnique({ where: { id: row.createdById } });
    if (!user || user.status !== 'ACTIVE' || user.municipalityId !== row.municipalityId) return null;
    const last = this.lastUsedWritten.get(row.id) ?? 0;
    if (Date.now() - last > LAST_USED_WRITE_MS) {
      this.lastUsedWritten.set(row.id, Date.now());
      void this.prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
    }
    return user;
  }

  // ----- Webhooks -----

  async listWebhooks(appUser: AppUser) {
    const rows = await this.prisma.webhook.findMany({
      where: { municipalityId: appUser.municipalityId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ secret: _secret, ...row }) => row);
  }

  /** The signing secret is returned once, here. */
  async createWebhook(appUser: AppUser, dto: CreateWebhookDto) {
    await assertPublicUrl(dto.url);
    if (!dto.events.length) throw new BadRequestException('Pick at least one event.');
    const row = await this.prisma.webhook.create({
      data: {
        municipalityId: appUser.municipalityId,
        name: dto.name.trim(),
        url: dto.url.trim(),
        events: dto.events,
        secret: `whsec_${randomBytes(24).toString('base64url')}`,
        createdById: appUser.id,
      },
    });
    return row;
  }

  async updateWebhook(appUser: AppUser, id: string, dto: UpdateWebhookDto) {
    await this.ownWebhook(appUser, id);
    if (dto.url) await assertPublicUrl(dto.url);
    const { secret: _secret, ...row } = await this.prisma.webhook.update({
      where: { id },
      data: {
        name: dto.name?.trim(),
        url: dto.url?.trim(),
        events: dto.events,
        active: dto.active,
      },
    });
    return row;
  }

  async deleteWebhook(appUser: AppUser, id: string) {
    await this.ownWebhook(appUser, id);
    await this.prisma.webhook.delete({ where: { id } });
  }

  /** Sends a "ping" right away and reports how it went. */
  async testWebhook(appUser: AppUser, id: string) {
    const hook = await this.ownWebhook(appUser, id);
    return this.deliver(hook, 'ping', { message: 'Test delivery from Municipal GIS.' }, 1);
  }

  /** Fire-and-forget: queues `event` to every matching active webhook. */
  emit(municipalityId: string, event: WebhookEvent, data: Record<string, unknown>): void {
    void (async () => {
      const hooks = await this.prisma.webhook.findMany({ where: { municipalityId, active: true } });
      for (const hook of hooks.filter((h) => h.events.includes('*') || h.events.includes(event))) {
        void this.deliver(hook, event, data, RETRY_DELAYS_MS.length);
      }
    })().catch((error) => this.logger.warn(`Webhook emit failed: ${(error as Error).message}`));
  }

  /** Same, for a change on one layer (resolves its municipality). */
  emitForLayer(layerId: string, event: WebhookEvent, data: Record<string, unknown>): void {
    void this.prisma.gISLayer
      .findUnique({ where: { id: layerId }, select: { name: true, gisWorkspace: { select: { municipalityId: true } } } })
      .then((layer) => {
        if (layer) this.emit(layer.gisWorkspace.municipalityId, event, { layerId, layerName: layer.name, ...data });
      })
      .catch(() => undefined);
  }

  private async ownWebhook(appUser: AppUser, id: string) {
    const hook = await this.prisma.webhook.findFirst({ where: { id, municipalityId: appUser.municipalityId } });
    if (!hook) throw new NotFoundException('Webhook not found.');
    return hook;
  }

  private async deliver(
    hook: { id: string; url: string; secret: string },
    event: WebhookEvent,
    data: Record<string, unknown>,
    attempts: number,
  ): Promise<{ ok: boolean; status: number | null; error: string | null }> {
    const deliveryId = randomUUID();
    const body = JSON.stringify({ id: deliveryId, event, occurredAt: new Date().toISOString(), data });
    const signature = createHmac('sha256', hook.secret).update(body).digest('hex');
    let status: number | null = null;
    let error: string | null = null;
    for (let i = 0; i < attempts; i++) {
      if (RETRY_DELAYS_MS[i]) await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[i]));
      try {
        const res = await safeFetch(hook.url, {
          method: 'POST',
          body,
          timeoutMs: 10_000,
          maxBytes: 64 * 1024,
          headers: {
            'Content-Type': 'application/json',
            'X-MGP-Event': event,
            'X-MGP-Delivery': deliveryId,
            'X-MGP-Signature': `sha256=${signature}`,
          },
        });
        status = res.status;
        error = res.status >= 200 && res.status < 300 ? null : `HTTP ${res.status}`;
      } catch (e) {
        status = null;
        error = (e as Error).message;
      }
      if (!error) break;
    }
    await this.prisma.webhook
      .update({ where: { id: hook.id }, data: { lastStatus: status, lastError: error, lastDeliveredAt: new Date() } })
      .catch(() => undefined);
    return { ok: !error, status, error };
  }
}
