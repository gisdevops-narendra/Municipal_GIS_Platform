import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ModuleAccessController } from './module-access.controller';
import { ModuleAccessService } from './module-access.service';

@Module({
  imports: [AuthModule],
  controllers: [ModuleAccessController],
  providers: [ModuleAccessService],
  exports: [ModuleAccessService],
})
export class ModuleAccessModule {}
