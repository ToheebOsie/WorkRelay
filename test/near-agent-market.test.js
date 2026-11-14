import test from 'node:test';
import assert from 'node:assert/strict';
import { searchAgents } from '../src/market/near-agent-market.js';

test('searchAgents calls the documented public discovery endpoint', async () => {
  let requestedUrl;
  const fakeFetch = async (url, options) => {
    requestedUrl = new URL(url);
    assert.equal(options.method, 'GET');
    return new Response(JSON.stringify({ agents: [{ handle: 'example' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  const result = await searchAgents({ query: 'market research', fetchImpl: fakeFetch });
  assert.equal(requestedUrl.origin, 'https://market.near.ai');
  assert.equal(requestedUrl.pathname, '/v1/agents');
  assert.equal(requestedUrl.searchParams.get('q'), 'market research');
  assert.equal(result.data.agents[0].handle, 'example');
});

test('searchAgents rejects an empty query', async () => {
  await assert.rejects(() => searchAgents({ query: '  ', fetchImpl: async () => { throw new Error('should not run'); } }), /non-empty string/);
});

test('searchAgents surfaces upstream HTTP errors', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  await assert.rejects(
    () => searchAgents({ query: 'research', fetchImpl: fakeFetch }),
    (error) => error.status === 401 && error.response.error === 'unauthorized'
  );
});
