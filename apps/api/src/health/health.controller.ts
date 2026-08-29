import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { pingDatabase } from '@daybook/db';

@Controller()
export class HealthController {
  /** Liveness: is the process up. Never touches the database. */
  @Get('healthz')
  live(): { status: string } {
    return { status: 'ok' };
  }

  /** Readiness: can this instance actually serve traffic. */
  @Get('readyz')
  async ready(): Promise<{ status: string; database: string }> {
    const database = await pingDatabase();
    if (!database) {
      throw new ServiceUnavailableException('Database is not reachable.');
    }
    return { status: 'ok', database: 'ok' };
  }
}
