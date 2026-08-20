import { Controller, Get, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { HealthService } from './health.service';
import { HealthQueryDto } from './health-query.dto';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({ summary: 'Service + dependency (PostgreSQL, Redis) health probe' })
  @ApiQuery({ name: 'verbose', required: false, type: Boolean, description: 'Return full checks' })
  async getHealth(@Query() query: HealthQueryDto, @Res({ passthrough: true }) res: Response) {
    const status = await this.health.check();
    // 503 when a dependency is down so orchestrators/readiness probes can react.
    if (status.status !== 'ok') {
      res.status(503);
    }
    if (query.verbose === true) {
      return status;
    }
    return {
      status: status.status,
      service: status.service,
      timestamp: status.timestamp,
    };
  }
}
