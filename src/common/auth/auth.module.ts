import { Module } from '@nestjs/common';
import { JwtGuard } from './jwt.guard';

@Module({
  providers: [JwtGuard],
  exports: [JwtGuard],
})
export class AuthModule {}
