import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutionClient } from '../public/execution-client.js';

function response(status, body, jsonFails=false) {
  return { ok: status >= 200 && status < 300, status, async json(){ if(jsonFails) throw new Error('bad json'); return body; } };
}

test('execution client loads an encoded execution ID without sending a mutation', async () => {
  const calls=[];
  const client=createExecutionClient(async (url, options)=>{calls.push({url,options});return response(200,{execution:{executionId:'exec-a'}});});
  const result=await client.get('exec/a');
  assert.equal(result.execution.executionId,'exec-a');
  assert.equal(calls[0].url,'/api/execution/exec%2Fa');
  assert.equal(calls[0].options.method,undefined);
  assert.equal(calls[0].options.cache,'no-store');
});

test('sync uses the existing read-only owner-scoped route and sends no commission fields', async () => {
  const calls=[]; const client=createExecutionClient(async (url,options)=>{calls.push({url,options});return response(200,{updates:[],execution:{}});});
  await client.sync('exec-123456789012');
  assert.equal(calls[0].url,'/api/execution/exec-123456789012/sync');
  assert.equal(calls[0].options.method,'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body),{});
});

test('evaluation targets one package and does not send acceptance or payment authorization', async () => {
  let sent; const client=createExecutionClient(async (url,options)=>{sent={url,body:JSON.parse(options.body)};return response(200,{evaluation:{kind:'structural'}});});
  const result=await client.evaluate('exec-123456789012','pkg-1');
  assert.equal(result.evaluation.kind,'structural');
  assert.equal(sent.url,'/api/execution/exec-123456789012/evaluate');
  assert.deepEqual(sent.body,{packageId:'pkg-1'});
});

test('acceptance sends the explicit accepted flag only for the selected package', async () => {
  let sent; const client=createExecutionClient(async (url,options)=>{sent={url,body:JSON.parse(options.body)};return response(200,{acceptance:{status:'accepted'}});});
  const result=await client.accept('exec-123456789012','pkg-2');
  assert.equal(result.acceptance.status,'accepted');
  assert.equal(sent.url,'/api/execution/exec-123456789012/accept');
  assert.deepEqual(sent.body,{packageId:'pkg-2',accepted:true});
  assert.equal(JSON.stringify(sent.body).includes('payment'),false);
});

test('client surfaces server rejection and ambiguous response states without retry', async () => {
  let count=0; const client=createExecutionClient(async()=>{count++;return response(409,{error:'Evaluation required before acceptance.'});});
  await assert.rejects(()=>client.accept('exec-123456789012','pkg'),/Evaluation required/);
  assert.equal(count,1);
});

test('client reports network failures and invalid JSON accurately', async () => {
  const network=createExecutionClient(async()=>{throw new Error('offline');});
  await assert.rejects(()=>network.get('exec-123456789012'),/Network error: offline/);
  const invalid=createExecutionClient(async()=>response(502,{},true));
  await assert.rejects(()=>invalid.sync('exec-123456789012'),/invalid response \(502\)/);
});

test('paid dispatch is exposed only as a separate explicit, preview-fingerprint-bound action', async () => {
  const calls=[]; const client=createExecutionClient(async(url,options)=>{ calls.push({url,options}); return response(200,{}); });
  assert.deepEqual(Object.keys(client).sort(),['accept','dispatch','evaluate','get','reconcile','recover','sync']);
  await client.dispatch('exec-1234567890123456','preview-hash');
  assert.match(calls[0].url,/\/dispatch$/);
  assert.deepEqual(JSON.parse(calls[0].options.body),{confirmed:true,previewFingerprint:'preview-hash'});
});


test('recovery and reconciliation are separate explicit owner actions', async () => {
  const calls = [];
  const client = createExecutionClient(async (url, options) => { calls.push({ url, body: options.body ? JSON.parse(options.body) : null }); return response(200, { recovered: [], execution: {} }); });
  await client.recover('exec-1234567890123456');
  assert.equal(calls[0].url, '/api/execution/exec-1234567890123456/recover');
  assert.deepEqual(calls[0].body, {});
  await client.reconcile('exec-1234567890123456', { packageId: 'pkg', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://market.near.ai/jobs/1' });
  assert.equal(calls[1].url, '/api/execution/exec-1234567890123456/reconcile');
  assert.deepEqual(calls[1].body, { packageId: 'pkg', outcome: 'rejected', paymentStatus: 'not_sent', evidenceReference: 'https://market.near.ai/jobs/1', confirmed: true });
});
