import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** Minimal atomic JSON persistence for local demos. Not a multi-process database. */
export async function saveExecution(filePath, execution) {
  if (typeof filePath !== 'string' || !filePath.trim()) throw new TypeError('filePath is required');
  if (!execution || typeof execution.executionId !== 'string') throw new TypeError('A valid execution is required');
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(execution, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, target);
  return target;
}

export async function loadExecution(filePath) {
  const raw = await readFile(resolve(filePath), 'utf8');
  const execution = JSON.parse(raw);
  if (!execution || typeof execution.executionId !== 'string' || !Array.isArray(execution.packages) || !Array.isArray(execution.ledger)) {
    throw new Error('Stored execution record is malformed');
  }
  return execution;
}
