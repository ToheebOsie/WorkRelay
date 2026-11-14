import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
const cents = (value) => Math.round(Number(value) * 100);
const dollars = (value) => Number((value / 100).toFixed(2));

/** Persistent, IP-scoped sponsored demo-credit ledger. Single-process only. */
export function createDemoCreditLedger({ filePath, secret, globalPoolUsd = 1000, perIpCapUsd = 10, projectCapUsd = 5, reservationTtlMs = 6 * 60 * 60 * 1000, now = () => Date.now() }) {
  if (!filePath || !secret || String(secret).length < 16) throw new Error('Demo ledger requires a file path and a secret of at least 16 characters.');
  const limits = { globalPoolCents: cents(globalPoolUsd), perIpCapCents: cents(perIpCapUsd), projectCapCents: cents(projectCapUsd) };
  if (Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0) || limits.projectCapCents > limits.perIpCapCents || limits.perIpCapCents > limits.globalPoolCents) throw new Error('Invalid demo-credit limits. Require 0 < project cap <= IP cap <= global pool.');
  const target = resolve(filePath); let queue = Promise.resolve();
  const hashIp = (ip) => createHmac('sha256', secret).update(String(ip)).digest('hex');
  async function load() {
    try { const state = JSON.parse(await readFile(target, 'utf8')); if (state.version !== 1 || !state.ips || !state.reservations) throw new Error('Malformed demo-credit ledger.'); return state; }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, consumedCents: 0, ips: {}, reservations: {} }; throw error; }
  }
  async function save(state) { await mkdir(dirname(target), { recursive: true }); const temp = `${target}.${process.pid}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' }); await rename(temp, target); }
  function expire(state) { const cutoff = now() - reservationTtlMs; for (const [id, r] of Object.entries(state.reservations)) if (r.createdAt < cutoff) { state.ips[r.ipHash].reservedCents -= r.amountCents; delete state.reservations[id]; } }
  const serial = (fn) => { const operation = queue.then(fn); queue = operation.catch(() => {}); return operation; };
  function snapshotFor(state, ipHash) {
    const ip = state.ips[ipHash] || { consumedCents: 0, reservedCents: 0 };
    const globalReserved = Object.values(state.reservations).reduce((sum, r) => sum + r.amountCents, 0);
    return { currency: 'USD', global: { limit: dollars(limits.globalPoolCents), consumed: dollars(state.consumedCents), reserved: dollars(globalReserved), remaining: dollars(Math.max(0, limits.globalPoolCents - state.consumedCents - globalReserved)) }, perIp: { limit: dollars(limits.perIpCapCents), consumed: dollars(ip.consumedCents), reserved: dollars(ip.reservedCents), remaining: dollars(Math.max(0, limits.perIpCapCents - ip.consumedCents - ip.reservedCents)) }, perProjectLimit: dollars(limits.projectCapCents) };
  }
  return {
    identify(ip) { return hashIp(ip); },
    async balance(ip) { return serial(async () => { const s = await load(); expire(s); await save(s); return snapshotFor(s, hashIp(ip)); }); },
    async reserve({ ip, projectId, amountUsd }) { return serial(async () => {
      const amountCents = cents(amountUsd); if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw Object.assign(new Error('Enter a positive demo-credit budget.'), { statusCode: 400 });
      if (amountCents > limits.projectCapCents) throw Object.assign(new Error(`A single demo project is capped at $${dollars(limits.projectCapCents).toFixed(2)}.`), { statusCode: 429 });
      const s = await load(); expire(s); const ipHash = hashIp(ip); const entry = s.ips[ipHash] ||= { consumedCents: 0, reservedCents: 0 }; const balance = snapshotFor(s, ipHash);
      if (amountCents > Math.round(balance.perIp.remaining * 100)) throw Object.assign(new Error(`This IP has $${balance.perIp.remaining.toFixed(2)} in demo credits remaining. Reduce the project budget or try later.`), { statusCode: 429, balance });
      if (amountCents > Math.round(balance.global.remaining * 100)) throw Object.assign(new Error('The shared $1,000 demo-credit pool is exhausted or temporarily reserved.'), { statusCode: 429, balance });
      if (s.reservations[projectId]) throw Object.assign(new Error('This project already has a demo-credit reservation.'), { statusCode: 409 });
      entry.reservedCents += amountCents; s.reservations[projectId] = { projectId, ipHash, amountCents, createdAt: now() }; await save(s);
      return { reservation: { projectId, amount: dollars(amountCents), status: 'reserved' }, balance: snapshotFor(s, ipHash) };
    }); },
    async settle({ ip, projectId, actualSpendUsd }) { return serial(async () => {
      const actualCents = cents(actualSpendUsd); if (!Number.isSafeInteger(actualCents) || actualCents < 0) throw Object.assign(new Error('Invalid simulated spend.'), { statusCode: 400 });
      const s = await load(); expire(s); const r = s.reservations[projectId]; if (!r || r.ipHash !== hashIp(ip)) throw Object.assign(new Error('Demo-credit reservation not found for this visitor.'), { statusCode: 404 });
      if (actualCents > r.amountCents) throw Object.assign(new Error('Simulated spend exceeds the reserved project budget.'), { statusCode: 409 });
      const ipEntry = s.ips[r.ipHash]; ipEntry.reservedCents -= r.amountCents; ipEntry.consumedCents += actualCents; s.consumedCents += actualCents; delete s.reservations[projectId]; await save(s);
      return { charged: dollars(actualCents), released: dollars(r.amountCents - actualCents), balance: snapshotFor(s, r.ipHash) };
    }); },
    async release({ ip, projectId }) { return serial(async () => { const s = await load(); expire(s); const r = s.reservations[projectId]; if (!r || r.ipHash !== hashIp(ip)) return { released: 0 }; s.ips[r.ipHash].reservedCents -= r.amountCents; delete s.reservations[projectId]; await save(s); return { released: dollars(r.amountCents) }; }); }
  };
}
