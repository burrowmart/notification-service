/**
 * Global setup for outbox e2e tests.
 *
 * Requires (start before running):
 *   docker-compose -f ../platform-infra/docker-compose.yml up -d redis rabbitmq
 *
 * MongoDB is started as a fresh single-node replica set using the locally
 * installed system `mongod` binary on port 27018. This avoids conflicts with
 * the local mongod on 27017 AND the mongodb-memory-server binary which can
 * crash silently. Change streams require a replica set (oplog is mandatory).
 */
import { spawn, execSync, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

const RS_NAME = 'rs0test';
let mongodProcess: ChildProcess | undefined;
let dataDir: string | undefined;

/** Find a free TCP port. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startRs(port: number): Promise<string> {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongo-outbox-test-'));
  const logFile = path.join(dataDir, 'mongod.log');

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'mongod',
      [
        '--replSet', RS_NAME,
        '--port', String(port),
        '--dbpath', dataDir!,
        '--logpath', logFile,
        '--logappend',
        '--bind_ip', '127.0.0.1',
      ],
      { detached: false, stdio: 'ignore' },
    );

    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`mongod exited with code ${code}`));
      }
    });
    mongodProcess = proc;

    // Give mongod ~2s to start accepting connections
    setTimeout(() => resolve(`mongodb://127.0.0.1:${port}`), 2_000);
  });
}

/**
 * Initiate the RS and wait for PRIMARY using mongosh — a fully separate
 * process so no mongoose module state bleeds into the test app.
 */
async function initRs(port: number): Promise<void> {
  const sh = (eval_: string) =>
    execSync(`mongosh --port ${port} --quiet --eval "${eval_}"`, {
      stdio: 'pipe',
      timeout: 10_000,
    }).toString().trim();

  // Wait for mongod to accept connections
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { sh('db.runCommand({ping:1})'); break; } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  // Initiate the replica set
  try {
    sh(`rs.initiate({_id:'${RS_NAME}',members:[{_id:0,host:'127.0.0.1:${port}'}]})`);
  } catch {
    // Might already be initiated if mongod was reused
  }

  // Wait until this node becomes PRIMARY (myState === 1)
  const tEnd = Date.now() + 20_000;
  while (Date.now() < tEnd) {
    try {
      const state = sh('rs.status().myState');
      if (state === '1') return;
    } catch { /* still transitioning */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`RS did not elect a primary within 20 s`);
}

export default async function globalSetup(): Promise<void> {
  const port = await getFreePort();
  const baseUri = await startRs(port);
  await initRs(port);

  process.env.MONGO_URI = `${baseUri}/notification-service-outbox-test?directConnection=true`;
  process.env.PORT = '3099';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'true';
  process.env.AUTH_DISABLED = 'true';
  process.env.RABBITMQ_URL =
    process.env.RABBITMQ_URL ?? 'amqp://guest:guest@localhost:5672';
  process.env.REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

  (globalThis as any).__OUTBOX_MONGOD__ = mongodProcess;
  (globalThis as any).__OUTBOX_DATADIR__ = dataDir;
}


