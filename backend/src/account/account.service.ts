import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateMeDto } from './dto/update-me.dto';

/** The signed-in account (GET/PATCH /api/me). Departments and roles were
 *  removed: every account owns its own workspace, so the role is always
 *  reported as MUNICIPALITY_OWNER (kept for the frontend's existing shape). */
@Injectable()
export class AccountService {
  constructor(private readonly prisma: PrismaService) {}

  async getMe(keycloakUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { keycloakUserId },
      include: { municipality: true },
    });
    if (!user) {
      throw new NotFoundException(
        'No account is linked to this sign-in. Create an account first.',
      );
    }
    return {
      id: user.id,
      keycloakUserId: user.keycloakUserId,
      name: user.fullName,
      email: user.email,
      mobileNumber: user.mobileNumber,
      systemRole: 'MUNICIPALITY_OWNER' as const,
      status: user.status,
      department: null,
      municipality: {
        id: user.municipality.id,
        name: user.municipality.name,
        type: user.municipality.type,
        state: user.municipality.state,
        district: user.municipality.district,
        city: user.municipality.city,
      },
    };
  }

  /** Own profile edit — name / mobile only. */
  async updateMe(keycloakUserId: string, dto: UpdateMeDto) {
    const user = await this.prisma.user.findUnique({ where: { keycloakUserId } });
    if (!user) {
      throw new NotFoundException('No account is linked to this sign-in.');
    }
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(dto.fullName !== undefined && { fullName: dto.fullName.trim() }),
        ...(dto.mobileNumber !== undefined && { mobileNumber: dto.mobileNumber }),
      },
    });
    return this.getMe(keycloakUserId);
  }
}
