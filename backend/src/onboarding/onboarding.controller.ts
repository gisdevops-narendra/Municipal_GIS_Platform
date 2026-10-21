import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  RequireMunicipalityMember,
  RequireMunicipalityOwner,
} from '../auth/decorators/authorization.decorators';
import { CurrentAppUser } from '../auth/decorators/current-app-user.decorator';
import type { AppUser } from '../auth/types/app-user.type';
import {
  ACKNOWLEDGEABLE_STEPS,
  OnboardingService,
  OnboardingStepId,
} from './onboarding.service';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';

/**
 * `/api/onboarding` — the municipality's Getting Started progress. Always
 * scoped to `appUser.municipalityId` (resolved from the JWT).
 */
@Controller('onboarding')
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @RequireMunicipalityMember()
  @Get()
  get(@CurrentAppUser() appUser: AppUser) {
    return this.onboardingService.getStatus(appUser.municipalityId);
  }

  /** Owner-only. Marks an optional step (e.g. Module Access review) done. */
  @RequireMunicipalityOwner()
  @Post('steps/:step/acknowledge')
  acknowledge(
    @CurrentAppUser() appUser: AppUser,
    @Param('step') step: string,
  ) {
    if (!ACKNOWLEDGEABLE_STEPS.includes(step as OnboardingStepId)) {
      throw new BadRequestException(
        `Step "${step}" completes automatically and cannot be acknowledged.`,
      );
    }
    return this.onboardingService.acknowledge(
      appUser.municipalityId,
      step as OnboardingStepId,
    );
  }

  /** Owner-only. Hides or re-shows the Getting Started guide. */
  @RequireMunicipalityOwner()
  @Patch()
  update(
    @CurrentAppUser() appUser: AppUser,
    @Body() dto: UpdateOnboardingDto,
  ) {
    return this.onboardingService.setDismissed(
      appUser.municipalityId,
      dto.dismissed,
    );
  }
}
