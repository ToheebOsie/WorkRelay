import test from 'node:test';
import assert from 'node:assert/strict';
import { syncExecutionFromProviders } from '../src/orchestration/provider-sync.js';

const execution = () => ({
  executionId: 'exec-1', status: 'work_in_progress', updatedAt: new Date().toISOString(), ledger: [],
  packages: [{ packageId: 'research', provider: 'provider-a', brief: 'Research', acceptanceCriteria: ['Cite sources'],
    commissioning: { status: 'commissioned', taskId: 'task-1', providerTaskState: null },
    delivery: { status: 'awaiting_provider', content: null, contentHash: null, receivedAt: null },
    evaluation: { status: 'not_evaluated', criterionResults: [], passed: null, evaluatedAt: null },
    acceptance: { status: 'not_requested', acceptedBy: null, acceptedAt: null },
    payment: { status: 'unknown', amount: 1, currency: 'USDC', transactionId: null, settledAt: null }
  }]
});

test('syncs a completed provider task into a hashed deliverable without accepting or settling it', async () => {
  const project = execution();
  const result = await syncExecutionFromProviders(project, { taskReader: async () => ({ status: 'task_retrieved', taskStatus: 'TASK_STATE_COMPLETED', artifacts: [{ text: 'A completed research deliverable with sufficient evidence and source links.' }] }) });
  assert.equal(result.updates[0].status, 'deliverable_recorded');
  assert.equal(project.packages[0].delivery.status, 'delivered_pending_evaluation');
  assert.ok(project.packages[0].delivery.contentHash);
  assert.equal(project.packages[0].acceptance.status, 'not_requested');
  assert.equal(project.packages[0].payment.status, 'unknown');
});

test('keeps working provider tasks in progress and does not create a deliverable', async () => {
  const project = execution();
  const result = await syncExecutionFromProviders(project, { taskReader: async () => ({ status: 'task_retrieved', taskStatus: 'TASK_STATE_WORKING', artifacts: [] }) });
  assert.equal(result.updates[0].status, 'still_in_progress');
  assert.equal(project.packages[0].delivery.status, 'awaiting_provider');
});
