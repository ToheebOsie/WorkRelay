import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoCreditLedger } from '../src/demo/demo-credit-ledger.js';

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'workrelay-demo-'));
  let clock = 1_000_000;
  const ledger = createDemoCreditLedger({ filePath: join(dir, 'credits.json'), secret: 'test-secret-at-least-16-chars', now: () => clock, ...options });
  return { ledger, dir, advance: (ms) => { clock += ms; }, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('new IP receives configured allowance and global pool is shared', async () => {
  const x = await setup({ globalPoolUsd: 20, perIpCapUsd: 10, projectCapUsd: 5 });
  try { const a = await x.ledger.balance('1.2.3.4'); const b = await x.ledger.balance('5.6.7.8'); assert.equal(a.perIp.remaining, 10); assert.equal(a.global.remaining, 20); assert.equal(b.perIp.remaining, 10); } finally { await x.cleanup(); }
});

test('reserves project budget against both per-IP and global limits', async () => {
  const x = await setup({ globalPoolUsd: 6, perIpCapUsd: 5, projectCapUsd: 5 });
  try {
    await x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p1', amountUsd: 4 });
    await assert.rejects(x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p2', amountUsd: 2 }), /IP has \$1.00/);
    await x.ledger.reserve({ ip: '2.2.2.2', projectId: 'p3', amountUsd: 2 });
    await assert.rejects(x.ledger.reserve({ ip: '3.3.3.3', projectId: 'p4', amountUsd: 1 }), /shared \$1,000 demo-credit pool/);
  } finally { await x.cleanup(); }
});

test('project cap cannot be bypassed by splitting across requests', async () => {
  const x = await setup({ perIpCapUsd: 10, projectCapUsd: 3 });
  try { await assert.rejects(x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p', amountUsd: 3.01 }), /single demo project is capped/); } finally { await x.cleanup(); }
});

test('settlement consumes simulated recommendations and releases unused reservation', async () => {
  const x = await setup({ perIpCapUsd: 10, projectCapUsd: 5 });
  try {
    await x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p', amountUsd: 5 });
    const settled = await x.ledger.settle({ ip: '1.1.1.1', projectId: 'p', actualSpendUsd: 2.4 });
    assert.equal(settled.charged, 2.4); assert.equal(settled.released, 2.6); assert.equal(settled.balance.perIp.remaining, 7.6); assert.equal(settled.balance.global.consumed, 2.4);
  } finally { await x.cleanup(); }
});

test('cannot settle above reservation or from a different IP', async () => {
  const x = await setup({ perIpCapUsd: 10, projectCapUsd: 5 });
  try {
    await x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p', amountUsd: 3 });
    await assert.rejects(x.ledger.settle({ ip: '1.1.1.1', projectId: 'p', actualSpendUsd: 3.01 }), /exceeds the reserved/);
    await assert.rejects(x.ledger.settle({ ip: '2.2.2.2', projectId: 'p', actualSpendUsd: 1 }), /not found/);
  } finally { await x.cleanup(); }
});

test('reservations expire and release capacity', async () => {
  const x = await setup({ perIpCapUsd: 5, projectCapUsd: 5, reservationTtlMs: 100 });
  try {
    await x.ledger.reserve({ ip: '1.1.1.1', projectId: 'p', amountUsd: 5 }); x.advance(101);
    assert.equal((await x.ledger.balance('1.1.1.1')).perIp.remaining, 5);
  } finally { await x.cleanup(); }
});

test('parallel reservations cannot oversubscribe the IP cap', async () => {
  const x = await setup({ globalPoolUsd: 100, perIpCapUsd: 5, projectCapUsd: 5 });
  try {
    const results = await Promise.allSettled(['a','b','c'].map((id) => x.ledger.reserve({ ip: '1.1.1.1', projectId: id, amountUsd: 2 })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    assert.equal((await x.ledger.balance('1.1.1.1')).perIp.reserved, 4);
  } finally { await x.cleanup(); }
});
