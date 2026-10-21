import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/** Order matters: each step unlocks only once every earlier mandatory
 *  step is complete (the frontend locks the matching menu until then). */
export const ONBOARDING_STEPS = [
  'account',
  'workspace',
  'departments',
  'users',
  'data',
  'access',
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number];

/** Steps the Owner completes by confirming them, not by creating data. */
export const ACKNOWLEDGEABLE_STEPS: readonly OnboardingStepId[] = ['access'];

const MANDATORY: ReadonlySet<OnboardingStepId> = new Set([
  'account',
  'workspace',
  'departments',
  'users',
  'data',
]);

interface StoredState {
  acknowledged?: string[];
  dismissed?: boolean;
}

export interface OnboardingStepStatus {
  id: OnboardingStepId;
  mandatory: boolean;
  done: boolean;
  /** Supporting number shown in the guide (departments, users, layers). */
  count: number | null;
}

export interface OnboardingStatus {
  steps: OnboardingStepStatus[];
  /** True once every mandatory step is done — unlocks the Municipal GIS map. */
  setupComplete: boolean;
  /** The Owner hid the guide (only allowed once setup is complete). */
  dismissed: boolean;
  workspaceStatus: 'PROVISIONING' | 'ACTIVE' | 'PROVISIONING_FAILED' | null;
}

/**
 * Getting Started guide for a newly registered municipality. Mandatory
 * steps are derived from the municipality's real data on every call, so
 * they can never drift out of sync with what actually exists:
 *
 *   account      always done — the municipality and Owner exist
 *   workspace    GIS workspace provisioned on GeoServer (ACTIVE)
 *   departments  at least one active department
 *   users        at least one active Department Head / User
 *   data         at least one upload published as a GIS layer
 *   access       optional — Owner confirms Module Access was reviewed
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(municipalityId: string): Promise<OnboardingStatus> {
    const [municipality, workspace, departments, users, published] =
      await this.prisma.$transaction([
        this.prisma.municipality.findUniqueOrThrow({
          where: { id: municipalityId },
          select: { onboardingState: true },
        }),
        this.prisma.gISWorkspace.findUnique({
          where: { municipalityId },
          select: { status: true },
        }),
        this.prisma.department.count({
          where: { municipalityId, status: 'ACTIVE' },
        }),
        this.prisma.user.count({
          where: {
            municipalityId,
            status: 'ACTIVE',
            systemRole: { not: 'MUNICIPALITY_OWNER' },
          },
        }),
        this.prisma.gISLayerUpload.count({
          where: { municipalityId, status: 'PUBLISHED' },
        }),
      ]);

    const state = this.readState(municipality.onboardingState);
    const acknowledged = new Set(state.acknowledged ?? []);

    const done: Record<OnboardingStepId, boolean> = {
      account: true,
      workspace: workspace?.status === 'ACTIVE',
      departments: departments > 0,
      users: users > 0,
      data: published > 0,
      access: acknowledged.has('access'),
    };
    const counts: Partial<Record<OnboardingStepId, number>> = {
      departments,
      users,
      data: published,
    };

    const steps = ONBOARDING_STEPS.map((id) => ({
      id,
      mandatory: MANDATORY.has(id),
      done: done[id],
      count: counts[id] ?? null,
    }));
    const setupComplete = steps.every((s) => !s.mandatory || s.done);

    return {
      steps,
      setupComplete,
      dismissed: setupComplete && !!state.dismissed,
      workspaceStatus: workspace?.status ?? null,
    };
  }

  async acknowledge(
    municipalityId: string,
    step: OnboardingStepId,
  ): Promise<OnboardingStatus> {
    await this.updateState(municipalityId, (state) => ({
      ...state,
      acknowledged: [...new Set([...(state.acknowledged ?? []), step])],
    }));
    return this.getStatus(municipalityId);
  }

  async setDismissed(
    municipalityId: string,
    dismissed: boolean,
  ): Promise<OnboardingStatus> {
    await this.updateState(municipalityId, (state) => ({
      ...state,
      dismissed,
    }));
    return this.getStatus(municipalityId);
  }

  private async updateState(
    municipalityId: string,
    change: (state: StoredState) => StoredState,
  ): Promise<void> {
    const row = await this.prisma.municipality.findUniqueOrThrow({
      where: { id: municipalityId },
      select: { onboardingState: true },
    });
    const next = change(this.readState(row.onboardingState));
    await this.prisma.municipality.update({
      where: { id: municipalityId },
      data: { onboardingState: next as Prisma.InputJsonValue },
    });
  }

  private readState(value: Prisma.JsonValue): StoredState {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as StoredState)
      : {};
  }
}
