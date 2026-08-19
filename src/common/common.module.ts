import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AuthModule } from './auth/auth.module';
import { JwtGuard } from './auth/jwt.guard';
import { CorrelationModule } from './correlation/correlation.module';
import { CorrelationInterceptor } from './correlation/correlation.interceptor';
import { AppLoggingModule } from './logging/logging.module';
import { MetricsModule } from './metrics/metrics.module';
import { MetricsDurationInterceptor } from './metrics/metrics-duration.interceptor';

@Global()
@Module({
  imports: [AuthModule, CorrelationModule, AppLoggingModule, MetricsModule],
  providers: [
    // CorrelationInterceptor runs first (outermost) so ALS is set before
    // MetricsDurationInterceptor starts its timer and before the handler runs.
    { provide: APP_GUARD, useClass: JwtGuard },
    { provide: APP_INTERCEPTOR, useClass: CorrelationInterceptor },
    { provide: APP_INTERCEPTOR, useClass: MetricsDurationInterceptor },
  ],
  exports: [CorrelationModule],
})
export class CommonModule {}
