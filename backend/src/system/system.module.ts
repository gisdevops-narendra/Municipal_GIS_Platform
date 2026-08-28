import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { GisModule } from '../gis/gis.module';
import { SystemController } from './system.controller';
import { SystemService } from './system.service';

@Module({
  imports: [AuthModule, GisModule],
  controllers: [SystemController],
  providers: [SystemService],
})
export class SystemModule {}
