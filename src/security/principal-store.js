import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { securePrivateFileSync } from '../storage/private-file-permissions.js';

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * Opaque, revocable browser capabilities mapped to server-side principals.
 * Tokens are returned once and only their SHA-256 hashes are persisted.
 * This is an identity primitive, not an account/password or MFA system.
 */
export function createPrincipalStore({
  filePath = null,
  ttlMs = 30 * 24 * 60 * 60 * 1000,
  maxPrincipals = 20_000,
  now = () => Date.now()
} = {}) {
  if (filePath !== null && (typeof filePath !== 'string' || !filePath.trim())) throw new TypeError('filePath must be a non-empty path.');
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be a positive integer.');
  if (!Number.isSafeInteger(maxPrincipals) || maxPrincipals <= 0) throw new TypeError('maxPrincipals must be a positive integer.');

  const target = filePath ? resolve(filePath) : null;
  const principals = new Map(); // token hash -> principal record

  function persist() {
    if (!target) return;
    mkdirSync(dirname(target), { recursive: true });
    const payload = { version: 1, principals: [...principals.values()] };
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      securePrivateFileSync(temporary);
      renameSync(temporary, target);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* preserve original error */ }
      throw error;
    }
  }

  function prune() {
    const cutoff = now() - ttlMs;
    let changed = false;
    for (const [key, value] of principals) {
      if (value.revokedAt || value.lastSeenAt < cutoff) { principals.delete(key); changed = true; }
    }
    while (principals.size > maxPrincipals) {
      const oldest = [...principals.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
      if (!oldest) break;
      principals.delete(oldest[0]); changed = true;
    }
    if (changed) persist();
  }

  if (target) {
    try {
      const parsed = JSON.parse(readFileSync(target, 'utf8'));
      if (parsed?.version !== 1 || !Array.isArray(parsed.principals)) throw new Error('Unsupported principal-store format.');
      for (const item of parsed.principals) {
        if (!item || typeof item.principalId !== 'string' || !/^[0-9a-f-]{36}$/i.test(item.principalId) || !/^[a-f0-9]{64}$/.test(item.tokenHash) || !Number.isFinite(item.createdAt) || !Number.isFinite(item.lastSeenAt)) {
          throw new Error('Malformed principal-store record.');
        }
        principals.set(item.tokenHash, item);
      }
      prune();
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Unable to load principal store: ${error.message}`, { cause: error });
    }
  }

  return {
    create() {
      prune();
      const token = randomBytes(TOKEN_BYTES).toString('base64url');
      const tokenHash = hashToken(token);
      const principal = { principalId: randomUUID(), tokenHash, createdAt: now(), lastSeenAt: now(), revokedAt: null };
      principals.set(tokenHash, principal);
      prune();
      persist();
      return { token, principal: { principalId: principal.principalId, createdAt: new Date(principal.createdAt).toISOString() } };
    },
    resolve(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
      const key = hashToken(token);
      const record = principals.get(key);
      if (!record || record.revokedAt || now() - record.lastSeenAt >= ttlMs) return null;
      // Compare fixed-size digests in constant time even though Map lookup already matched.
      const supplied = Buffer.from(key, 'hex');
      const stored = Buffer.from(record.tokenHash || key, 'hex');
      if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return null;
      record.lastSeenAt = now();
      principals.delete(key);
      principals.set(key, record);
      persist();
      return { principalId: record.principalId, createdAt: new Date(record.createdAt).toISOString() };
    },
    revoke(token) {
      if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return false;
      const removed = principals.delete(hashToken(token));
      if (removed) persist();
      return removed;
    },
    get size() { prune(); return principals.size; }
  };
}
