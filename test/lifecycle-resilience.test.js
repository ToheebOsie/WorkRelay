import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createExecutionBridge } from '../src/orchestration/execution-bridge.js';
import { recordPackageDeliverable } from '../src/orchestration/project-lifecycle.js';
import { createExecutionRecordStore } from '../src/storage/execution-record-store.js';

function fixture() {
  return {
    executionId: 'wr-exec-resilience-12345678',
    status: 'work_in_progress',
    approval: { confirmed: true, maxSpend: 10 },
    packages: [{
      packageId: 'research', title: 'Research', provider: 'provider-a', price: 5, currency: 'USDC',
      brief: 'Produce a research report with evidence and sources.',
      acceptanceCriteria: ['Include research findings and source citations'],
      commissioning: { status: 'commissioned', taskId: 'task-resilience-1', providerTaskState: null },
      delivery: { status: 'awaiting_provider', content: null, contentHash: null, receivedAt: null },
      evaluation: { status: 'not_evaluated', criterionResults: [], passed: null, evaluatedAt: null },
      acceptance: { status: 'not_requested', acceptedBy: null, acceptedAt: null },
      payment: { mode: 'marketplace_escrow', status: 'held', amount: 5, currency: 'USDC', transactionId: null, settledAt: null }
    }],
    ledger: []
  };
}

test('interrupted provider synchronization is persisted and can safely resume after restart', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-sync-resume-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = createExecutionRecordStore(dir);
  const execution = fixture();
  const firstBridge = createExecutionBridge({
    taskReader: async () => { throw new Error('provider temporarily unavailable'); },
    persist: (record) => store.save(record)
  });

  const first = await firstBridge.sync(execution);
  assert.equal(first.updates[0].status, 'request_failed');
  assert.equal(execution.packages[0].delivery.status, 'awaiting_provider');
  assert.equal(execution.packages[0].commissioning.lastSyncError.status, 'request_failed');
  assert.equal(execution.packages[0].payment.status, 'held');
  assert.equal(execution.packages[0].acceptance.status, 'not_requested');

  const restored = await store.load(execution.executionId);
  assert.equal(restored.packages[0].delivery.status, 'awaiting_provider');
  assert.equal(restored.packages[0].commissioning.lastSyncError.status, 'request_failed');
  assert.equal(restored.packages[0].payment.status, 'held');

  const secondBridge = createExecutionBridge({
    taskReader: async () => ({ status: 'task_retrieved', taskStatus: 'TASK_STATE_WORKING', artifacts: [] }),
    persist: (record) => store.save(record)
  });
  const resumed = await secondBridge.sync(restored);
  assert.equal(resumed.updates[0].status, 'still_in_progress');
  assert.equal(restored.packages[0].delivery.status, 'awaiting_provider');
  assert.equal(restored.packages[0].payment.status, 'held');
});

test('provider-rejected task becomes attention-required and is not polled again as awaiting work', async () => {
  const execution = fixture();
  let reads = 0;
  const bridge = createExecutionBridge({
    taskReader: async () => { reads += 1; return { status: 'task_retrieved', taskStatus: 'TASK_STATE_FAILED', artifacts: [] }; }
  });
  const first = await bridge.sync(execution);
  assert.equal(first.updates[0].status, 'provider_task_failed');
  assert.equal(execution.packages[0].delivery.status, 'provider_task_failed');
  assert.equal(execution.status, 'attention_required');
  assert.equal(execution.packages[0].acceptance.status, 'not_requested');
  assert.equal(execution.packages[0].payment.status, 'held');

  const second = await bridge.sync(execution);
  assert.deepEqual(second.updates, []);
  assert.equal(reads, 1, 'terminal failed tasks must not be polled through the awaiting-provider path');
  assert.equal(execution.packages[0].payment.status, 'held');
});

test('failed structural evaluation blocks human acceptance without changing payment state', async () => {
  const execution = fixture();
  recordPackageDeliverable(execution, {
    packageId: 'research', taskId: 'task-resilience-1',
    content: 'Research findings with a short overview. Source: https://example.org/report'
  });
  const bridge = createExecutionBridge({
    evaluator: async ({ acceptanceCriteria }) => ({
      criterionResults: acceptanceCriteria.map((criterion) => ({ criterion, passed: false, evidence: '', reason: 'Required evidence is missing.' }))
    })
  });

  await bridge.evaluate(execution, 'research');
  assert.equal(execution.packages[0].evaluation.passed, false);
  assert.equal(execution.packages[0].delivery.status, 'revision_required');
  await assert.rejects(() => bridge.accept(execution, { packageId: 'research', acceptedBy: 'project owner' }), /has not passed evaluation/);
  assert.equal(execution.packages[0].acceptance.status, 'not_requested');
  assert.equal(execution.packages[0].payment.status, 'held');
});
