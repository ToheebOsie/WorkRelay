import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

// Single-process file store for execution records. Not a distributed lock/database.
export function createExecutionRecordStore(directory) {
  if (typeof directory !== 'string' || !directory.trim()) throw new TypeError('Execution record directory is required.');
  const root = resolve(directory);
  const fileFor = (id) => {
    if (typeof id !== 'string' || !/^[a-z0-9-]{16,80}$/i.test(id)) throw new TypeError('Invalid execution ID.');
    return join(root, `${id}.json`);
  };
  return {
    async save(execution) {
      if (!execution || typeof execution.executionId !== 'string' || !Array.isArray(execution.packages) || !Array.isArray(execution.ledger)) throw new TypeError('A valid execution record is required.');
      const target = fileFor(execution.executionId);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(execution, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
      } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
      }
      return target;
    },
    async load(id) {
      const record = JSON.parse(await readFile(fileFor(id), 'utf8'));
      if (!record || record.executionId !== id || !Array.isArray(record.packages) || !Array.isArray(record.ledger)) throw new Error('Stored execution record is malformed.');
      return record;
    },
    pathFor: fileFor
  };
}
