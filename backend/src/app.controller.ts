import { Controller, Get } from '@nestjs/common';
import { AppService } from './app.service';

/** Unauthenticated health check used by Docker Compose and manual smoke
 *  testing to confirm the backend started successfully. */
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }
}
