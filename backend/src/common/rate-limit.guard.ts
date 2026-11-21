import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UseGuards,
  applyDecorators,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { clientIp } from './client-ip';

export interface RateRule {
  /** Bucket name, e.g. 'signup'. */
  name: string;
  /** Max requests per window, per client IP. */
  perIp: number;
  /** Optional cap across all clients (protects against spread-out bots). */
  global?: number;
  windowMs: number;
}

const RULE_KEY = 'rateLimitRule';

/**
 * In-memory sliding-window rate limit for sensitive public/password
 * endpoints (sign-up, password-confirmed account actions). Single backend
 * instance, so memory is enough; replace with Redis if this ever scales out.
 */
export function RateLimit(rule: RateRule) {
  return applyDecorators(SetMetadata(RULE_KEY, rule), UseGuards(RateLimitGuard));
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private static readonly hits = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const rule = this.reflector.get<RateRule | undefined>(RULE_KEY, context.getHandler());
    if (!rule) return true;
    const req = context.switchToHttp().getRequest();
    const now = Date.now();
    const checks: [string, number][] = [[`${rule.name}:ip:${clientIp(req)}`, rule.perIp]];
    if (rule.global) checks.push([`${rule.name}:all`, rule.global]);

    for (const [key, limit] of checks) {
      const recent = (RateLimitGuard.hits.get(key) ?? []).filter((t) => now - t < rule.windowMs);
      if (recent.length >= limit) {
        const retryAfter = Math.ceil((rule.windowMs - (now - recent[0])) / 1000);
        context.switchToHttp().getResponse().setHeader?.('Retry-After', String(retryAfter));
        throw new HttpException(
          `Too many attempts. Please try again in ${retryAfter >= 120 ? `${Math.ceil(retryAfter / 60)} minutes` : `${retryAfter} seconds`}.`,
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      RateLimitGuard.hits.set(key, recent);
    }
    for (const [key] of checks) RateLimitGuard.hits.get(key)!.push(now);

    // Keep memory bounded: drop idle buckets now and then.
    if (RateLimitGuard.hits.size > 5000) {
      for (const [key, times] of RateLimitGuard.hits) {
        if (!times.length || now - times[times.length - 1] > 3_600_000) RateLimitGuard.hits.delete(key);
      }
    }
    return true;
  }
}
