import { BadRequestException } from '@nestjs/common';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

/**
 * Outbound HTTP to user-supplied URLs (external map services, webhooks).
 * Only http(s); hosts that resolve to loopback / private / link-local
 * addresses are refused (SSRF guard) unless EXTERNAL_FETCH_ALLOW_PRIVATE
 * is "true" — e.g. a LAN GeoServer in a dev setup. Redirects are followed
 * by hand so every hop is checked the same way.
 */
export interface SafeFetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  allowPrivate?: boolean;
}

export interface SafeFetchResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const MAX_REDIRECTS = 3;

export function allowPrivateFromEnv(): boolean {
  return (process.env.EXTERNAL_FETCH_ALLOW_PRIVATE ?? '').toLowerCase() === 'true';
}

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateV4(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('ff');
}

/** Throws BadRequest unless `raw` is an http(s) URL to a public host. */
export async function assertPublicUrl(raw: string, allowPrivate = allowPrivateFromEnv()): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('Not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('Only http:// and https:// URLs are allowed.');
  }
  if (url.username || url.password) {
    throw new BadRequestException('URLs with embedded credentials are not allowed.');
  }
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  } catch {
    throw new BadRequestException(`Could not resolve host "${host}".`);
  }
  if (!addresses.length || addresses.some(isPrivateIp)) {
    throw new BadRequestException('That address points to a private or internal network and is not allowed.');
  }
  return url;
}

export async function safeFetch(raw: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const allowPrivate = options.allowPrivate ?? allowPrivateFromEnv();
  const maxBytes = options.maxBytes ?? 15 * 1024 * 1024;
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicUrl(current, allowPrivate);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers: { 'User-Agent': 'MunicipalGIS/1.0', ...(options.headers ?? {}) },
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        current = new URL(res.headers.get('location') as string, url).toString();
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new BadRequestException('The response is too large.');
      const chunks: Buffer[] = [];
      let size = 0;
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > maxBytes) {
            controller.abort();
            throw new BadRequestException('The response is too large.');
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      return { status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks) };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const aborted = (error as Error).name === 'AbortError';
      throw new BadRequestException(aborted ? 'The service took too long to answer.' : `Could not reach the service: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new BadRequestException('Too many redirects.');
}
