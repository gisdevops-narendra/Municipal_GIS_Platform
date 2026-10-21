import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AI_ASSISTANT_MODULE_ID, AiAssistantGuard } from './ai-assistant.guard';
import type { ModuleAccessService } from '../module-access/module-access.service';

describe('AiAssistantGuard', () => {
  const context = {
    switchToHttp: () => ({ getRequest: () => ({ appUser: { id: 'u1' } }) }),
  } as unknown as ExecutionContext;

  const guardWith = (ids: number[]) =>
    new AiAssistantGuard({
      getEffectiveModuleIdsForAppUser: jest.fn().mockResolvedValue(new Set(ids)),
    } as unknown as ModuleAccessService);

  it('lets a user with the AI Assistant module through', async () => {
    await expect(guardWith([1, AI_ASSISTANT_MODULE_ID]).canActivate(context)).resolves.toBe(true);
  });

  it('refuses a user without it, even though the map hides the tool', async () => {
    await expect(guardWith([1, 2, 3]).canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
