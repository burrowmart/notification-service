import { Controller, Get, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { register } from 'prom-client';
import { Public } from '../auth/public.decorator';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressResponse = any;

@ApiExcludeController()
@Public()
@Controller('metrics')
export class MetricsController {
  @Get()
  async metrics(@Res() res: ExpressResponse): Promise<void> {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  }
}
