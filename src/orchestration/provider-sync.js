import { getProviderTask } from '../market/near-a2a-quotes.js';
import { recordPackageDeliverable } from './project-lifecycle.js';

/**
 * Read-only refresh of commissioned provider tasks. Completed text artifacts are
 * attached to the execution; failures and non-terminal states remain separate
 * from payment/acceptance state. This function never retries a commission.
 */
export async function syncExecutionFromProviders(execution, { taskReader = getProviderTask } = {}) {
  if (!execution || !Array.isArray(execution.packages)) throw new TypeError('A valid execution record is required');
  const updates = [];
  for (const item of execution.packages) {
    if (item.commissioning.status !== 'commissioned' || item.delivery.status !== 'awaiting_provider') continue;
    const result = await taskReader({ agent: { handle: item.provider }, taskId: item.commissioning.taskId });
    const state = result?.taskStatus ?? null;
    const normalizedState = String(state ?? '').toLowerCase().replace(/^task_state_/, '');
    item.commissioning.providerTaskState = state;
    if (result?.status !== 'task_retrieved') {
      updates.push({ packageId: item.packageId, status: result?.status ?? 'lookup_failed', reason: result?.reason ?? null });
      continue;
    }
    if (['failed', 'canceled', 'rejected'].includes(normalizedState)) {
      item.delivery.status = 'provider_task_failed';
      execution.ledger.push({ event: 'provider_task_failed', at: new Date().toISOString(), details: { packageId: item.packageId, taskId: item.commissioning.taskId, taskState: state } });
      updates.push({ packageId: item.packageId, status: 'provider_task_failed', taskState: state });
      continue;
    }
    if (normalizedState !== 'completed') {
      updates.push({ packageId: item.packageId, status: 'still_in_progress', taskState: state });
      continue;
    }
    const content = (result.artifacts ?? []).map((artifact) => artifact.text).filter((text) => typeof text === 'string' && text.trim()).join('\n\n');
    if (content.trim().length < 20) {
      updates.push({ packageId: item.packageId, status: 'completed_without_text_artifact', taskState: state });
      continue;
    }
    recordPackageDeliverable(execution, { packageId: item.packageId, taskId: item.commissioning.taskId, content });
    updates.push({ packageId: item.packageId, status: 'deliverable_recorded', taskState: state, contentHash: item.delivery.contentHash });
  }
  execution.updatedAt = new Date().toISOString();
  return { execution, updates };
}
