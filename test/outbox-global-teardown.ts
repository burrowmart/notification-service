import * as fs from 'fs';

export default async function globalTeardown(): Promise<void> {
  const proc = (globalThis as any).__OUTBOX_MONGOD__;
  if (proc) {
    proc.kill('SIGTERM');
    // Give mongod a moment to flush and exit
    await new Promise((r) => setTimeout(r, 1_000));
    proc.kill('SIGKILL');
  }
  const dir = (globalThis as any).__OUTBOX_DATADIR__;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}
