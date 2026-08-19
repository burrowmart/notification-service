import type { MongoMemoryReplSet } from 'mongodb-memory-server';

export default async function globalTeardown(): Promise<void> {
  const mongod: MongoMemoryReplSet | undefined = (global as any).__MONGOD__;
  await mongod?.stop();
}
