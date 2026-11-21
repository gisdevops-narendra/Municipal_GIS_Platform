/** Best-effort client IP: the first X-Forwarded-For hop (set by the dev
 *  proxy / a reverse proxy), else the socket address. */
export function clientIp(req: { headers?: Record<string, unknown>; ip?: string; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers?.['x-forwarded-for'];
  const first = (Array.isArray(xff) ? xff[0] : typeof xff === 'string' ? xff : '').split(',')[0].trim();
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}
