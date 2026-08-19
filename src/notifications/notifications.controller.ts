import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { JwtPayload } from 'jsonwebtoken';
import { NotificationsService } from './notifications.service';
import { Claims } from '../common/auth/claims.decorator';
import { NotificationPageResponse, UnreadCountResponse } from './dto/notification.response';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  // Static segment — must be declared before ':id/read' only matters if the
  // two could overlap; they can't (different path depth), listed first for readability.
  @Get('unread-count')
  @ApiOkResponse({
    type: UnreadCountResponse,
    description: 'Unread count for the authenticated user (Redis-only read)',
  })
  getUnreadCount(@Claims() claims: JwtPayload) {
    return this.service.getUnreadCount(claims.email as string);
  }

  @Get()
  // Declared explicitly: bare @Query() params carry no metadata, so without
  // these the generated openapi.yaml drops the pagination contract entirely.
  @ApiQuery({ name: 'page', required: false, schema: { type: 'integer', minimum: 1, default: 1 } })
  @ApiQuery({ name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } })
  @ApiOkResponse({
    type: NotificationPageResponse,
    description: 'Paginated notifications for the authenticated user (Mongo-only read)',
  })
  list(
    @Claims() claims: JwtPayload,
    @Query('page') page = '1',
    @Query('limit') limit = '20',
  ) {
    return this.service.list(claims.email as string, +page, +limit);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Marked read (Mongo update + Redis DECR, floored at 0)' })
  markAsRead(@Claims() claims: JwtPayload, @Param('id') id: string) {
    return this.service.markAsRead(id, claims.email as string);
  }
}
