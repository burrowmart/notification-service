import { Injectable, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { getCorrelationId } from './correlation.context';

/**
 * Registers a single Axios request interceptor on the provided HttpService so
 * every outbound REST call automatically carries the current correlationId.
 * Modules that need outbound HTTP should import CorrelationModule (which exports
 * HttpModule + this interceptor) rather than HttpModule directly.
 */
@Injectable()
export class CorrelationHttpInterceptor implements OnModuleInit {
  constructor(private readonly httpService: HttpService) {}

  onModuleInit(): void {
    this.httpService.axiosRef.interceptors.request.use(config => {
      const id = getCorrelationId();
      if (id) {
        config.headers['x-correlation-id'] = id;
      }
      return config;
    });
  }
}
