import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Bounded session store with optional atomic, single-process file persistence.
// This is suitable for a single local/demo server, not multi-instance deployment.
export function createSessionStore({
  ttlMs = 6 * 60 * 60 * 1000,
  maxSessions = 2000,
  now = () => Date.now(),
  filePath = null
} = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive integer.');
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) throw new Error('maxSessions must be a positive integer.');
  if (filePath !== null && (typeof filePath !== 'string' || !filePath.trim())) throw new Error('filePath must be a non-empty path when provided.');

  const target = filePath ? resolve(filePath) : null;
  const entries = new Map(); // id -> { session, touchedAt }; oldest first

  function persist() {
    if (!target) return;
    mkdirSync(dirname(target), { recursive: true });
    const payload = {
      version: 1,
      savedAt: new Date(now()).toISOString(),
      entries: [...entries].map(([id, entry]) => ({ id, session: entry.session, touchedAt: entry.touchedAt }))
    };
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* preserve the original persistence error */ }
      throw error;
    }
  }

  function prune() {
    const t = now();
    let changed = false;
    for (const [id, entry] of entries) {
      if (t - entry.touchedAt >= ttlMs) { entries.delete(id); changed = true; }
    }
    while (entries.size > maxSessions) {
      entries.delete(entries.keys().next().value);
      changed = true;
    }
    if (changed) persist();
  }

  if (target) {
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) throw new Error('Stored session database has an unsupported or malformed format.');
      for (const item of parsed.entries) {
        if (!item || typeof item.id !== 'string' || !item.id || !Object.prototype.hasOwnProperty.call(item, 'session') || !Number.isFinite(item.touchedAt)) {
          throw new Error('Stored session database contains a malformed entry.');
        }
        entries.set(item.id, { session: item.session, touchedAt: item.touchedAt });
      }
      prune();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Unable to load persisted sessions: ${error.message}`, { cause: error });
    }
  }

  return {
    get(id) {
      prune();
      const entry = entries.get(id);
      if (!entry) return undefined;
      entry.touchedAt = now();
      entries.delete(id);
      entries.set(id, entry);
      persist();
      return entry.session;
    },
    set(id, session) {
      if (typeof id !== 'string' || !id) throw new TypeError('A non-empty session id is required.');
      entries.delete(id);
      entries.set(id, { session, touchedAt: now() });
      prune();
      persist();
      return this;
    },
    delete(id) {
      const deleted = entries.delete(id);
      if (deleted) persist();
      return deleted;
    },
    get size() { prune(); return entries.size; }
  };
}
