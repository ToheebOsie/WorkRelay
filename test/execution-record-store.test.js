import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionRecordStore } from '../src/storage/execution-record-store.js';

async function temp(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-exec-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const record = (executionId = 'exec-1234567890abcdef') => ({ executionId, packages: [{ packageId: 'p1', commissioning: { status: 'request_in_progress' }, payment: { status: 'unknown' }, price: 1, currency: 'USDC', provider: 'provider-a' }], ledger: [] });

test('execution record store persists, reloads, and atomically updates execution records', async (t) => {
  const dir = await temp(t); const store = createExecutionRecordStore(dir); const value = record();
  await store.save(value);
  const mode = (await stat(store.pathFor(value.executionId))).mode & 0o777;
  assert.equal(mode, 0o600);
  value.status = 'dispatch_blocked_reconciliation_required';
  await store.save(value);
  assert.equal((await createExecutionRecordStore(dir).load(value.executionId)).status, value.status);
});

test('execution record store rejects malformed IDs and corrupt records', async (t) => {
  const dir = await temp(t); const store = createExecutionRecordStore(dir);
  await assert.rejects(store.load('../outside'), /Invalid execution ID/);
  const path = store.pathFor('exec-1234567890abcdef');
  await writeFile(path, '{bad json');
  await assert.rejects(store.load('exec-1234567890abcdef'));
});
