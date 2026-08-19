import { Module } from '@nestjs/common';
import { collectDefaultMetrics, register } from 'prom-client';
import { MetricsController } from './metrics.controller';
import { MetricsDurationInterceptor } from './metrics-duration.interceptor';

// Guard against duplicate invocation during hot-reload
if (!register.getSingleMetric('process_cpu_user_seconds_total')) {
  collectDefaultMetrics();
}

@Module({
  controllers: [MetricsController],
  providers: [MetricsDurationInterceptor],
  exports: [MetricsDurationInterceptor],
})
export class MetricsModule {}
