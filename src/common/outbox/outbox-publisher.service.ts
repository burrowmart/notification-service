import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import * as amqplib from 'amqplib';
import { EXCHANGES } from '@demo/contracts';
import { OutboxEntity, OutboxDocument } from './schemas/outbox.schema';
import {
  OutboxStateEntity,
  OutboxStateDocument,
} from './schemas/outbox-state.schema';
import { LeaderLockService } from './leader-lock.service';

const STATE_ID = 'default';

@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxPublisherService.name);
  private changeStream?: ReturnType<Model<OutboxDocument>['watch']>;
  // amqplib.connect returns ChannelModel, not the low-level Connection interface
  private amqpConn?: amqplib.ChannelModel;
  private amqpCh?: amqplib.ConfirmChannel;

  /**
   * Test-only hook: called immediately before the AMQP publish for each row.
   * Throw from this hook to simulate a crash between DB commit and publish.
   */
  prePublishHook?: (doc: OutboxDocument) => Promise<void>;

  constructor(
    @InjectModel(OutboxEntity.name)
    private readonly outboxModel: Model<OutboxDocument>,
    @InjectModel(OutboxStateEntity.name)
    private readonly stateModel: Model<OutboxStateDocument>,
    private readonly leaderLock: LeaderLockService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // Allow disabling the publisher in test environments without RabbitMQ/Redis
    if (!this.config.get<boolean>('outboxPublisherEnabled')) {
      this.logger.log('Outbox publisher disabled via OUTBOX_PUBLISHER_ENABLED');
      return;
    }

    const acquired = await this.leaderLock.acquire();
    if (!acquired) {
      this.logger.log('Standby replica — outbox publisher inactive');
      return;
    }

    // If we lose the lock mid-flight (e.g. Redis partition) stop the stream
    this.leaderLock.onLockLost(() => { void this.stop(); });

    await this.connectAmqp();
    await this.start();
  }

  private async connectAmqp(): Promise<void> {
    const url = this.config.get<string>('rabbitmqUrl')!;
    const conn = await amqplib.connect(url);
    const ch = await conn.createConfirmChannel();

    // Assert every exchange so the publisher never races with the first message
    await ch.assertExchange(EXCHANGES.DOMAIN_EVENTS, 'topic', { durable: true });
    await ch.assertExchange(EXCHANGES.SAGA_COMMANDS, 'direct', { durable: true });
    await ch.assertExchange(EXCHANGES.SAGA_REPLIES, 'direct', { durable: true });

    this.amqpConn = conn;
    this.amqpCh = ch;
    this.logger.log('AMQP channel ready');
  }

  /**
   * Opens the change stream (resuming from the persisted token) and drains
   * any backlog committed while this instance was not the leader.
   *
   * Safe to call more than once (e.g. in tests after stop()).
   */
  async start(): Promise<void> {
    // Close any previously-open stream before opening a new one.
    // Cap at 3 s — if the cursor connection is dead, the close may wait
    // for serverSelectionTimeout (30 s default); we don't want that.
    if (this.changeStream) {
      await Promise.race([
        this.changeStream.close(),
        new Promise<void>((r) => setTimeout(r, 3_000)),
      ]).catch(() => undefined);
      this.changeStream = undefined;
    }
    const state = await this.stateModel.findById(STATE_ID).lean().exec();
    const streamOpts = state?.resumeToken
      ? { resumeAfter: state.resumeToken as object }
      : {};

    // Open stream BEFORE draining backlog so no insert is missed in the gap
    this.changeStream = this.outboxModel.watch(
      [{ $match: { operationType: 'insert' } }],
      { ...streamOpts, fullDocument: 'default' as const },
    );

    this.changeStream.on('change', (event: any) => {
      // Handle errors so Jest (and production) don't see unhandled rejections.
      // A failed handleEvent is OK — drainBacklog() on next start recovers the row.
      this.handleEvent(event).catch((err: Error) => {
        this.logger.warn({ err }, 'Outbox event handler failed — row will be retried');
      });
    });

    this.changeStream.on('error', (err: Error) => {
      this.logger.error({ err }, 'Change stream error');
    });

    this.logger.log(
      state?.resumeToken
        ? 'Change stream resumed from token'
        : 'Change stream started fresh',
    );

    // Drain rows committed while publisher was down (covers the crash-before-publish scenario)
    await this.drainBacklog();
  }

  /** Publish all rows that are still unpublished (at-least-once safety net).
   *  Also accessible by tests to simulate restart recovery without stream teardown. */
  async drainBacklog(): Promise<void> {
    const docs = await this.outboxModel
      .find({ published: false })
      .sort({ createdAt: 1 })
      .lean()
      .exec();

    if (docs.length > 0) {
      this.logger.log(`Draining ${docs.length} unpublished outbox row(s)`);
    }

    for (const doc of docs) {
      await this.publishDoc(doc as unknown as OutboxDocument);
    }
  }

  private async handleEvent(event: any): Promise<void> {
    const doc: OutboxDocument = event.fullDocument;
    if (!doc) return;

    // Re-read published flag — drainBacklog may have already processed this row
    const current = await this.outboxModel
      .findOne({ _id: doc._id, published: false })
      .lean()
      .exec();
    if (!current) return; // already published

    await this.publishDoc(current as unknown as OutboxDocument);
    // Advance the token only after a confirmed publish + DB mark
    await this.persistResumeToken(event._id);
  }

  private async publishDoc(doc: OutboxDocument): Promise<void> {
    if (this.prePublishHook) await this.prePublishHook(doc);

    // Wait for broker confirmation before marking published
    await new Promise<void>((resolve, reject) =>
      this.amqpCh!.publish(
        doc.exchange,
        doc.routingKey,
        Buffer.from(JSON.stringify(doc.envelope)),
        {
          messageId: doc.envelope.messageId,
          correlationId: doc.envelope.correlationId,
          contentType: 'application/json',
          persistent: true,
        },
        (err) => (err ? reject(err) : resolve()),
      ),
    );

    // Use conditional update — no-op if already marked by a concurrent path
    await this.outboxModel.updateOne(
      { _id: (doc as any)._id, published: false },
      { $set: { published: true, publishedAt: new Date() } },
    );

    this.logger.debug(
      {
        messageId: doc.envelope.messageId,
        type: doc.envelope.type,
      },
      'Outbox row published',
    );
  }

  private async persistResumeToken(token: object): Promise<void> {
    await this.stateModel.findByIdAndUpdate(
      STATE_ID,
      { $set: { resumeToken: token } },
      { upsert: true },
    );
  }

  /** Close the change stream cleanly (called on lock loss or shutdown). */
  async stop(): Promise<void> {
    const stream = this.changeStream;
    this.changeStream = undefined;
    if (stream) {
      await stream.close().catch(() => undefined);
    }
    this.logger.log('Outbox change stream stopped');
  }

  async onApplicationShutdown(): Promise<void> {
    await this.stop();
    try {
      await this.amqpCh?.close();
      await this.amqpConn?.close(); // ChannelModel.close() closes the underlying TCP connection
    } catch {
      // Ignore errors during shutdown
    }
  }
}
