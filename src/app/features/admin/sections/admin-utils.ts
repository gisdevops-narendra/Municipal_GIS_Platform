/** Small formatting helpers shared by the Admin console sections. */
export function bytes(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(1)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(v / 1024))} KB`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : new Date(iso).toLocaleDateString();
}

export function errorText(err: unknown, fallback: string): string {
  const e = err as { error?: { message?: string | string[] } };
  const m = e?.error?.message;
  return Array.isArray(m) ? m.join(' ') : m || fallback;
}
