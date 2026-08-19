import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CorrelationInterceptor } from './correlation.interceptor';
import { CorrelationHttpInterceptor } from './correlation.http';

@Module({
  imports: [HttpModule],
  providers: [CorrelationInterceptor, CorrelationHttpInterceptor],
  // Export HttpModule so downstream modules get the correlation-patched HttpService
  exports: [CorrelationInterceptor, CorrelationHttpInterceptor, HttpModule],
})
export class CorrelationModule {}
