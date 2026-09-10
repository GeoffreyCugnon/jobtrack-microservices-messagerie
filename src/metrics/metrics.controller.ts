import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeEndpoint } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../auth/public.decorator';
import { SkipRateLimit } from '../common/skip-rate-limit.decorator';
import { MetricsService } from './metrics.service';

/**
 * `GET /metrics` — exposition Prometheus (format texte). Publique (scrapée par
 * Prometheus, pas de JWT) et hors rate limiting, comme `GET /health`.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @SkipRateLimit()
  @ApiExcludeEndpoint()
  @Get()
  async scrape(@Res() res: Response): Promise<void> {
    res.set('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }
}
