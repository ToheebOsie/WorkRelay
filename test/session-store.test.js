import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../src/orchestration/session-store.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'workrelay-session-store-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('session store returns stored sessions and reports size', () => {
  const store = createSessionStore();
  store.set('a', { n: 1 });
  assert.deepEqual(store.get('a'), { n: 1 });
  assert.equal(store.get('missing'), undefined);
  assert.equal(store.size, 1);
});

test('session store expires idle sessions but keeps recently used ones alive', () => {
  let t = 0;
  const store = createSessionStore({ ttlMs: 1000, now: () => t });
  store.set('idle', { n: 1 }); store.set('active', { n: 2 });
  t = 600; assert.ok(store.get('active'));
  t = 1100;
  assert.equal(store.get('idle'), undefined);
  assert.ok(store.get('active'));
});

test('session store evicts the least recently used session beyond the cap', () => {
  const store = createSessionStore({ maxSessions: 2 });
  store.set('a', 1); store.set('b', 2);
  store.get('a');
  store.set('c', 3);
  assert.equal(store.get('b'), undefined);
  assert.equal(store.get('a'), 1);
  assert.equal(store.get('c'), 3);
  assert.equal(store.size, 2);
});

test('session store rejects invalid limits and paths', () => {
  assert.throws(() => createSessionStore({ ttlMs: 0 }));
  assert.throws(() => createSessionStore({ maxSessions: -1 }));
  assert.throws(() => createSessionStore({ filePath: '' }));
});

test('file-backed sessions survive store recreation and persist explicit session updates', () => withTempDir((dir) => {
  const filePath = join(dir, 'data', 'sessions.json');
  const first = createSessionStore({ filePath });
  first.set('project-1', { id: 'project-1', mode: 'demo', proposal: null });
  const restored = createSessionStore({ filePath });
  const session = restored.get('project-1');
  assert.deepEqual(session, { id: 'project-1', mode: 'demo', proposal: null });
  session.proposal = { status: 'simulation_only' };
  restored.set('project-1', session);
  const afterRestart = createSessionStore({ filePath });
  assert.deepEqual(afterRestart.get('project-1').proposal, { status: 'simulation_only' });
}));

test('file-backed store preserves expiry and capacity rules across restart', () => withTempDir((dir) => {
  const filePath = join(dir, 'sessions.json');
  let t = 100;
  const first = createSessionStore({ filePath, ttlMs: 1000, maxSessions: 2, now: () => t });
  first.set('a', { n: 1 }); first.set('b', { n: 2 });
  first.get('a');
  first.set('c', { n: 3 });
  t = 1200;
  const restored = createSessionStore({ filePath, ttlMs: 1000, maxSessions: 2, now: () => t });
  assert.equal(restored.get('a'), undefined);
  assert.equal(restored.get('b'), undefined);
  assert.equal(restored.get('c'), undefined);
  assert.equal(restored.size, 0);
}));

test('file-backed session file is private and malformed persistence fails closed', () => withTempDir((dir) => {
  const filePath = join(dir, 'sessions.json');
  const store = createSessionStore({ filePath });
  store.set('safe', { id: 'safe' });
  assert.equal(statSync(filePath).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(filePath, 'utf8'));
  assert.equal(raw.version, 1);
  writeFileSync(filePath, '{not-json', 'utf8');
  assert.throws(() => createSessionStore({ filePath }), /Unable to load persisted sessions/);
}));
