import { Global, Module } from '@nestjs/common';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformController } from './platform.controller';

/** Platform-wide settings, available to every module (the auth guard reads
 *  the maintenance flag). */
@Global()
@Module({
  controllers: [PlatformController],
  providers: [PlatformSettingsService],
  exports: [PlatformSettingsService],
})
export class PlatformModule {}
