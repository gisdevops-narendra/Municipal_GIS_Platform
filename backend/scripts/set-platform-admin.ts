/**
 * Grant or revoke platform-admin rights:
 *   npx ts-node -T scripts/set-platform-admin.ts someone@example.com        # grant
 *   npx ts-node -T scripts/set-platform-admin.ts someone@example.com --revoke
 * Run inside the backend container (docker exec municipal-gis-backend …).
 *
 * Admin accounts are for platform administration only — they have no map
 * workspace. Granting moves the user into its own "Platform administration"
 * account (out of any map workspace it shared); the old workspace and its
 * data stay with its other users. Use a dedicated account for admin work.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const [rawEmail, flag] = process.argv.slice(2);
  if (!rawEmail) throw new Error('Usage: set-platform-admin.ts <email> [--revoke]');
  const email = rawEmail.trim().toLowerCase();
  const prisma = new PrismaClient();
  const grant = flag !== '--revoke';
  let user = await prisma.user.update({ where: { email }, data: { isPlatformAdmin: grant } });

  if (grant) {
    const tenant = await prisma.municipality.findUnique({
      where: { id: user.municipalityId },
      include: { users: { select: { id: true } }, gisWorkspace: { select: { id: true } } },
    });
    const alreadyAdminOnly = tenant && tenant.users.length === 1 && !tenant.gisWorkspace;
    if (!alreadyAdminOnly) {
      const adminTenant = await prisma.municipality.create({
        data: {
          name: 'Platform administration',
          type: 'Admin',
          state: '',
          district: '',
          city: '',
          officialEmail: `admin+${user.id}@platform.local`,
          contactNumber: '',
        },
      });
      user = await prisma.user.update({ where: { id: user.id }, data: { municipalityId: adminTenant.id } });
      console.log(`moved ${email} out of its map workspace into an admin-only account`);
    }
  }

  console.log(`${user.email}: platform admin ${grant ? 'granted' : 'revoked'}`);
  await prisma.auditLog.create({
    data: {
      action: grant ? 'admin.granted' : 'admin.revoked',
      actorEmail: 'cli',
      accountId: user.municipalityId,
      targetType: 'user',
      targetId: user.id,
      details: { email: user.email },
    },
  });
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
