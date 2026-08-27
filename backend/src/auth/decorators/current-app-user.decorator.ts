import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AppUser } from '../types/app-user.type';
import type { RequestWithAppUser } from '../guards/app-user.guard';

/**
 * Extracts the resolved application user set by AppUserGuard. Only usable
 * on routes protected by that guard.
 */
export const CurrentAppUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AppUser => {
    const request = ctx.switchToHttp().getRequest<RequestWithAppUser>();
    return request.appUser;
  },
);
