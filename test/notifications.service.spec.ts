import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsRepository } from '../src/notifications/notifications.repository';
import { NotificationsService } from '../src/notifications/notifications.service';
import { NotificationsRedisService } from '../src/notifications/redis/notifications-redis.service';

const MOCK_DOC = {
  _id: '507f1f77bcf86cd799439011',
  userEmail: 'alice@example.com',
  type: 'ORDER_CONFIRMED',
  payload: { orderId: 'order-1', sagaId: 'saga-1' },
  read: false,
  createdAt: new Date('2024-01-01T00:00:00.000Z'),
};

const mockRepo: jest.Mocked<NotificationsRepository> = {
  create: jest.fn(),
  findPage: jest.fn(),
  findRecent: jest.fn(),
  countUnread: jest.fn(),
  markRead: jest.fn(),
} as any;

const mockRedis: jest.Mocked<NotificationsRedisService> = {
  recordUnread: jest.fn().mockResolvedValue(undefined),
  publish: jest.fn().mockResolvedValue(undefined),
  decrementUnread: jest.fn().mockResolvedValue(undefined),
  getUnreadCount: jest.fn(),
} as any;

describe('NotificationsService', () => {
  let service: NotificationsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: NotificationsRepository, useValue: mockRepo },
        { provide: NotificationsRedisService, useValue: mockRedis },
      ],
    }).compile();

    service = module.get(NotificationsService);
    jest.clearAllMocks();
  });

  describe('recordEvent', () => {
    it('persists to Mongo, then INCR/LPUSH, then PUBLISH — in that order', async () => {
      const calls: string[] = [];
      mockRepo.create.mockImplementation(async () => {
        calls.push('mongo');
        return MOCK_DOC as any;
      });
      mockRedis.recordUnread.mockImplementation(async () => {
        calls.push('redis-hot-layer');
      });
      mockRedis.publish.mockImplementation(async () => {
        calls.push('redis-publish');
      });

      const result = await service.recordEvent('alice@example.com', 'ORDER_CONFIRMED', {
        orderId: 'order-1',
        sagaId: 'saga-1',
      });

      expect(calls).toEqual(['mongo', 'redis-hot-layer', 'redis-publish']);
      expect(result.userEmail).toBe('alice@example.com');
      expect(result.read).toBe(false);
      expect(mockRedis.recordUnread).toHaveBeenCalledWith('alice@example.com', expect.objectContaining({ id: MOCK_DOC._id }));
      expect(mockRedis.publish).toHaveBeenCalledWith('alice@example.com', expect.objectContaining({ id: MOCK_DOC._id }));
    });
  });

  describe('getUnreadCount', () => {
    it('reads from the Redis hot layer (lazy-rebuild is internal to NotificationsRedisService)', async () => {
      mockRedis.getUnreadCount.mockResolvedValue(3);
      const result = await service.getUnreadCount('alice@example.com');
      expect(result).toEqual({ count: 3 });
    });
  });

  describe('markAsRead', () => {
    it('DECRs Redis when the Mongo flag actually flips', async () => {
      mockRepo.markRead.mockResolvedValue(true);
      await service.markAsRead(MOCK_DOC._id, 'alice@example.com');
      expect(mockRedis.decrementUnread).toHaveBeenCalledWith('alice@example.com');
    });

    it('skips the DECR when already read (idempotent — no double-decrement)', async () => {
      mockRepo.markRead.mockResolvedValue(false);
      await service.markAsRead(MOCK_DOC._id, 'alice@example.com');
      expect(mockRedis.decrementUnread).not.toHaveBeenCalled();
    });
  });
});
