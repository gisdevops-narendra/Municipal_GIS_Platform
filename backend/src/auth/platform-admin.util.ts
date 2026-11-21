/** Platform admin = users.is_platform_admin, or an email listed in
 *  PLATFORM_ADMIN_EMAILS (comma-separated, for bootstrapping).
 *  Admin accounts manage the platform only — they have no map workspace. */
export function isPlatformAdmin(user: { email: string; isPlatformAdmin?: boolean }): boolean {
  if (user.isPlatformAdmin) return true;
  const list = (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(user.email.toLowerCase());
}
