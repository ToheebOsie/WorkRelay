const DEFAULT_BASE_URL = 'https://market.near.ai';

/**
 * Search the public NEAR Agent Market catalogue.
 * The official A2A+x402 guide documents GET /v1/agents?q=<query>.
 * We deliberately preserve the upstream response instead of assuming a schema.
 */
export async function searchAgents({ query, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch }) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TypeError('query must be a non-empty string');
  }

  const url = new URL('/v1/agents', baseUrl);
  url.searchParams.set('q', query.trim());

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { accept: 'application/json' }
  });

  const bodyText = await response.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = { raw: bodyText };
  }

  if (!response.ok) {
    const error = new Error(`NEAR Agent Market discovery failed: HTTP ${response.status}`);
    error.status = response.status;
    error.response = body;
    throw error;
  }

  return { url: url.toString(), status: response.status, data: body };
}
