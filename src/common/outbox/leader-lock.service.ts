import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { randomUUID } from 'crypto';
import { OUTBOX_REDIS_CLIENT } from './outbox.tokens';

@Injectable()
export class LeaderLockService implements OnApplicationShutdown {
  private readonly logger = new Logger(LeaderLockService.name);
  private readonly lockKey = 'outbox:leader-lock';
  /** Lock TTL must be longer than renewEveryMs to survive a slow renewal tick. */
  private readonly ttlMs = 15_000;
  private readonly renewEveryMs = 5_000;
  /** Unique value per process instance — Lua scripts check this to prevent releasing another holder's lock. */
  private readonly lockValue = randomUUID();
  private renewTimer?: NodeJS.Timeout;
  private readonly lostCallbacks: Array<() => void> = [];

  constructor(
    @Inject(OUTBOX_REDIS_CLIENT) private readonly redis: Redis | null,
  ) {}

  async acquire(): Promise<boolean> {
    if (!this.redis) return false;

    const result = await this.redis.set(
      this.lockKey,
      this.lockValue,
      'PX',
      this.ttlMs,
      'NX',
    );
    if (result !== 'OK') return false;

    // Start background renewal — keeps the lock alive as long as this process runs
    this.renewTimer = setInterval(() => void this.renew(), this.renewEveryMs);
    this.logger.log('Leader lock acquired');
    return true;
  }

  private async renew(): Promise<void> {
    if (!this.redis) return;
    // Atomic check-and-extend: only extend if we still own the key
    const ok = (await this.redis.eval(
      `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end`,
      1,
      this.lockKey,
      this.lockValue,
      String(this.ttlMs),
    )) as number;

    if (ok === 0) {
      this.logger.warn('Leader lock lost — stopping outbox publisher');
      clearInterval(this.renewTimer);
      this.lostCallbacks.forEach((cb) => cb());
    }
  }

  /** Register a callback to be called when the lock is lost to another replica. */
  onLockLost(cb: () => void): void {
    this.lostCallbacks.push(cb);
  }

  async release(): Promise<void> {
    if (!this.redis) return;
    clearInterval(this.renewTimer);
    // Atomic delete — only delete if we still own the key
    await this.redis.eval(
      `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end`,
      1,
      this.lockKey,
      this.lockValue,
    );
    this.logger.log('Leader lock released');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.release();
  }
}
