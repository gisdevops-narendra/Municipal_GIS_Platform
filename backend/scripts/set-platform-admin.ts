/**
 * Grant or revoke platform-admin rights:
 *   npx ts-node -T scripts/set-platform-admin.ts someone@example.com        # grant
 *   npx ts-node -T scripts/set-platform-admin.ts someone@example.com --revoke
 * Run inside the backend container (docker exec municipal-gis-backend …).
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const [email, flag] = process.argv.slice(2);
  if (!email) throw new Error('Usage: set-platform-admin.ts <email> [--revoke]');
  const prisma = new PrismaClient();
  const grant = flag !== '--revoke';
  const user = await prisma.user.update({ where: { email: email.trim().toLowerCase() }, data: { isPlatformAdmin: grant } });
  console.log(`${user.email}: platform admin ${grant ? 'granted' : 'revoked'}`);
  await prisma.auditLog.create({
    data: { action: grant ? 'admin.granted' : 'admin.revoked', actorEmail: 'cli', accountId: user.municipalityId, targetType: 'user', targetId: user.id, details: { email: user.email } },
  });
  await prisma.$disconnect();
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
