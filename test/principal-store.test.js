import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrincipalStore } from '../src/security/principal-store.js';

const temp = (fn) => { const dir = mkdtempSync(join(tmpdir(), 'workrelay-principals-')); try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); } };

test('issues high-entropy opaque tokens and distinct server-side principals', () => {
  const store = createPrincipalStore();
  const a = store.create(); const b = store.create();
  assert.match(a.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.principal.principalId, b.principal.principalId);
  assert.equal(store.resolve(a.token).principalId, a.principal.principalId);
  assert.equal(store.resolve(b.token).principalId, b.principal.principalId);
});

test('never persists raw bearer tokens and persists only token hashes with private permissions', () => temp((dir) => {
  const path = join(dir, 'principals.json');
  const store = createPrincipalStore({ filePath: path });
  const { token } = store.create();
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes(token), false);
  assert.match(raw, /tokenHash/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
}));

test('revoked and malformed capabilities cannot resolve', () => {
  const store = createPrincipalStore();
  const { token } = store.create();
  assert.equal(store.revoke(token), true);
  assert.equal(store.resolve(token), null);
  assert.equal(store.resolve('not-a-token'), null);
  assert.equal(store.revoke(token), false);
});

test('principal records survive restart and expire after inactivity', () => temp((dir) => {
  const path = join(dir, 'principals.json'); let time = 10_000;
  const first = createPrincipalStore({ filePath: path, ttlMs: 1000, now: () => time });
  const { token, principal } = first.create();
  const second = createPrincipalStore({ filePath: path, ttlMs: 1000, now: () => time });
  assert.equal(second.resolve(token).principalId, principal.principalId);
  time += 1001;
  const third = createPrincipalStore({ filePath: path, ttlMs: 1000, now: () => time });
  assert.equal(third.resolve(token), null);
}));

test('malformed persisted principal state fails closed', () => temp((dir) => {
  const path = join(dir, 'principals.json');
  writeFileSync(path, '{broken');
  assert.throws(() => createPrincipalStore({ filePath: path }), /Unable to load principal store/);
}));
