import { readPaymentRequiredHeader, selectedRequirementMatches } from '../payments/x402-authorization.js';
const DEFAULT_DOMAIN = 'market.near.ai';
const X402_SCHEME = 'exact';
const NEAR_MAINNET = 'near:mainnet';
const CARD_PATHS = ['/.well-known/agent-card.json', '/.well-known/agent.json'];

function parseJsonText(text) {
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text }; }
}

function safeHandle(handle) {
  if (typeof handle !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(handle)) {
    throw new TypeError('Provider handle is missing or invalid; refusing to construct an endpoint');
  }
  return handle;
}

function findPaymentChallenge(body, headerChallenge = null) {
  const candidates = [
    headerChallenge,
    body?.paymentRequired,
    body?.payment_required,
    body?.payment,
    body?.error?.paymentRequired,
    body?.error?.payment_required,
    body?.result?.metadata?.['x402/payment'],
    body?.result?.status?.message?.metadata?.['x402/payment'],
    body?.result?.status?.message?.metadata?.['x402.payment.required'],
    body?.result?.status?.message?.metadata?.['x402.payment.required']?.paymentRequired,
    body?.result?.metadata?.['x402.payment.required'],
    body?.result?.metadata?.['x402.payment.required']?.paymentRequired,
    body,
    body?.accepts
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      if (candidate.length) return { x402Version: 1, resource: null, accepts: candidate, raw: { accepts: candidate }, source: 'response_body_legacy' };
      continue;
    }
    if (!candidate || typeof candidate !== 'object') continue;
    const accepts = Array.isArray(candidate.accepts) ? candidate.accepts
      : candidate.paymentRequired && Array.isArray(candidate.paymentRequired.accepts) ? candidate.paymentRequired.accepts
      : null;
    if (accepts?.length) {
      return {
        x402Version: Number(candidate.x402Version ?? candidate.version ?? candidate.paymentRequired?.x402Version ?? 0),
        resource: candidate.resource ?? candidate.paymentRequired?.resource ?? null,
        accepts,
        raw: candidate,
        source: candidate === headerChallenge ? 'payment_required_header' : 'response_body'
      };
    }
    if (candidate.scheme || candidate.amount || candidate.maxAmountRequired) {
      return { x402Version: 1, resource: null, accepts: [candidate], raw: candidate, source: 'response_body_legacy' };
    }
  }
  return null;
}

function schemaInput(agent, workPackage) {
  const schema = agent.inputSchema ?? agent.input_schema;
  if (!schema || typeof schema !== 'object') return { kind: 'text', text: workPackage.brief, schemaUsed: false };
  const properties = schema.properties ?? schema.schema?.properties;
  if (!properties || typeof properties !== 'object') return { error: 'Provider published an input schema WorkRelay cannot interpret safely' };
  const required = schema.required ?? schema.schema?.required ?? [];
  const values = {
    brief: workPackage.brief,
    task: workPackage.brief,
    objective: workPackage.brief,
    prompt: workPackage.brief,
    query: workPackage.brief,
    description: workPackage.brief,
    must_include: workPackage.acceptanceCriteria,
    acceptance_criteria: workPackage.acceptanceCriteria,
    output_format: 'markdown',
    format: 'markdown',
    sources_hint: 'Prioritise primary sources; include source URLs; label uncertainty and estimates.'
  };
  const input = {};
  for (const key of Object.keys(properties)) {
    if (Object.hasOwn(values, key)) input[key] = values[key];
    else if (Object.hasOwn(properties[key] ?? {}, 'default')) input[key] = properties[key].default;
    else if (Array.isArray(properties[key]?.enum) && properties[key].enum.length) input[key] = properties[key].enum[0];
  }
  const missing = required.filter((key) => !Object.hasOwn(input, key));
  if (missing.length) return { error: `Unsupported required provider input fields: ${missing.join(', ')}` };
  return { kind: 'text', text: JSON.stringify(input), schemaUsed: true, structuredInput: input };
}

function extractTaskState(body) {
  return body?.result?.status?.state
    ?? body?.result?.task?.status?.state
    ?? body?.task?.status?.state
    ?? body?.status?.state
    ?? null;
}

function resolveA2AInterface(card, origin) {
  const interfaces = Array.isArray(card?.supportedInterfaces) ? card.supportedInterfaces : [];
  let selected = interfaces.find((item) => String(item?.protocolBinding ?? '').toUpperCase() === 'JSONRPC');
  let endpoint = selected?.url;
  let protocolVersion = selected?.protocolVersion ?? '1.0';

  // A2A v0.3-era cards used top-level url/preferredTransport instead of supportedInterfaces.
  if (!endpoint && typeof card?.url === 'string') {
    const transport = String(card.preferredTransport ?? '').toLowerCase();
    if (!transport || transport.includes('jsonrpc')) endpoint = card.url;
    protocolVersion = card.protocolVersion ?? '0.3';
  }
  if (typeof endpoint !== 'string' || !endpoint.trim()) {
    return { error: 'Agent Card does not publish a supported JSON-RPC endpoint' };
  }
  let parsed;
  try { parsed = new URL(endpoint, origin); } catch { return { error: 'Agent Card contains an invalid A2A endpoint URL' }; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    return { error: 'Agent Card endpoint must be an HTTPS URL without credentials or fragment' };
  }
  const expectedHost = new URL(origin).hostname;
  if (parsed.hostname !== expectedHost) {
    return { error: `Agent Card endpoint host ${parsed.hostname} does not match provider host ${expectedHost}; refusing cross-host routing` };
  }
  return { endpoint: parsed.toString(), protocolVersion, tenant: selected?.tenant ?? null };
}

async function discoverA2AInterface({ origin, fetchImpl, signal }) {
  const observations = [];
  for (const path of CARD_PATHS) {
    const url = new URL(path, origin).toString();
    let response;
    let body;
    try {
      response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json' }, signal });
      body = parseJsonText(await response.text());
    } catch (error) {
      observations.push({ url, error: error.message });
      continue;
    }
    observations.push({ url, httpStatus: response.status, contentType: response.headers?.get?.('content-type') ?? null });
    if (!response.ok || !body || typeof body !== 'object' || body.raw) continue;
    const resolved = resolveA2AInterface(body, origin);
    if (!resolved.error) return { ...resolved, cardUrl: url, observations };
    observations[observations.length - 1].cardError = resolved.error;
  }
  return { error: 'Could not discover a usable JSON-RPC endpoint from the provider Agent Card', observations };
}

/**
 * Discover the provider's A2A endpoint from its Agent Card, then request an unpaid
 * quote. This function never sends payment headers, signs transactions or retries with payment.
 */
export async function requestProviderQuote({
  agent,
  workPackage,
  fetchImpl = fetch,
  timeoutMs = 15000,
  requestId = `workrelay-quote-${Date.now()}`
}) {
  const handle = safeHandle(agent?.handle);
  if (!workPackage?.brief || !Array.isArray(workPackage.acceptanceCriteria)) {
    throw new TypeError('workPackage must include a brief and acceptanceCriteria array');
  }
  const prepared = schemaInput(agent, workPackage);
  if (prepared.error) return { status: 'schema_unsupported', provider: handle, reason: prepared.error, quote: null };

  const origin = `https://${handle}.${DEFAULT_DOMAIN}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let discovered;
  try {
    discovered = await discoverA2AInterface({ origin, fetchImpl, signal: controller.signal });
    if (discovered.error) {
      return { status: 'endpoint_discovery_failed', provider: handle, endpoint: null, reason: discovered.error, observations: discovered.observations, quote: null };
    }

    const message = {
      role: 'user',
      messageId: `${requestId}-message`,
      parts: [{ kind: 'text', text: prepared.text }]
    };
    const params = { message };
    if (discovered.tenant) params.tenant = discovered.tenant;
    const payload = { jsonrpc: '2.0', id: requestId, method: 'SendMessage', params };
    const response = await fetchImpl(discovered.endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'A2A-Version': discovered.protocolVersion
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = parseJsonText(await response.text());
    const paymentChallenge = findPaymentChallenge(body, readPaymentRequiredHeader(response.headers));
    const accepts = paymentChallenge?.accepts ?? [];
    const taskState = extractTaskState(body);
    if (response.status !== 402 && !(response.ok && (taskState === 'input-required' || accepts.length))) {
      return {
        status: 'quote_unavailable', provider: handle, endpoint: discovered.endpoint,
        cardUrl: discovered.cardUrl, cardObservations: discovered.observations,
        httpStatus: response.status,
        allow: response.headers?.get?.('allow') ?? null,
        responseContentType: response.headers?.get?.('content-type') ?? null,
        taskState,
        responseBody: body,
        reason: body?.error?.message ?? body?.message ?? `Expected HTTP 402 or an input-required payment task; received HTTP ${response.status}`,
        quote: null
      };
    }
    if (!accepts.length) {
      return { status: 'malformed_quote', provider: handle, endpoint: discovered.endpoint, httpStatus: response.status, reason: 'Payment-required response did not contain an accepts array', responseBody: body, quote: null };
    }
    return {
      status: 'quote_received', provider: handle, endpoint: discovered.endpoint,
      cardUrl: discovered.cardUrl, cardObservations: discovered.observations,
      httpStatus: response.status, taskState, schemaUsed: prepared.schemaUsed,
      requestPayload: payload,
      quote: { receivedAt: new Date().toISOString(), alternatives: accepts, paymentChallenge, rawResponse: body }
    };
  } catch (error) {
    return {
      status: error?.name === 'AbortError' ? 'timeout' : 'request_failed',
      provider: handle, endpoint: discovered?.endpoint ?? null,
      reason: error.message, quote: null
    };
  } finally {
    clearTimeout(timeout);
  }
}

/** Validate one payment option against WorkRelay's explicit quote policy. */
export function normalizePaymentTerms(terms) {
  if (!terms || typeof terms !== 'object') return terms;
  // x402 v2 uses `amount`; some legacy/payment adapters expose `maxAmountRequired`.
  const amount = terms.amount ?? terms.maxAmountRequired;
  return { ...terms, amount, maxAmountRequired: amount };
}

export function validatePaymentTerms(terms, {
  allowedNetworks = [],
  allowedSchemes = [X402_SCHEME],
  allowedAssets = [],
  allowedAssetsByNetwork = null,
  expectedCurrency = 'USDC'
} = {}) {
  const errors = [];
  terms = normalizePaymentTerms(terms);
  if (!terms || typeof terms !== 'object') return { valid: false, errors: ['Payment terms are not an object'] };
  if (!allowedSchemes.includes(terms.scheme)) errors.push(`Unsupported payment scheme: ${terms.scheme ?? 'missing'}`);
  if (!allowedNetworks.includes(terms.network)) errors.push(`Unsupported network: ${terms.network ?? 'missing'}`);
  const networkAssets = allowedAssetsByNetwork && typeof allowedAssetsByNetwork === 'object'
    ? (allowedAssetsByNetwork[terms.network] ?? [])
    : allowedAssets;
  if (!terms.asset || !networkAssets.some((asset) => String(asset).toLowerCase() === String(terms.asset).toLowerCase())) errors.push(`Payment asset is not allowlisted for ${terms.network ?? 'the selected network'}: ${terms.asset ?? 'missing'}`);
  if (typeof terms.payTo !== 'string' || !terms.payTo.trim()) errors.push('Missing payment recipient (payTo)');
  if (String(terms.network ?? '').startsWith('eip155:') && !/^0x[a-fA-F0-9]{40}$/.test(String(terms.payTo ?? ''))) errors.push('EVM payTo must be a 20-byte hexadecimal address');
  if (typeof terms.maxAmountRequired !== 'string' || !/^\d+$/.test(terms.maxAmountRequired) || BigInt(terms.maxAmountRequired) <= 0n) {
    errors.push('maxAmountRequired must be a positive integer string in atomic units');
  }
  if (!Number.isSafeInteger(Number(terms.maxTimeoutSeconds)) || Number(terms.maxTimeoutSeconds) <= 0 || Number(terms.maxTimeoutSeconds) > 86400) errors.push('maxTimeoutSeconds must be an integer from 1 to 86400');
  return {
    valid: errors.length === 0, errors, currency: expectedCurrency,
    amountAtomic: /^\d+$/.test(String(terms.amount ?? '')) ? String(terms.amount) : null,
    scheme: terms.scheme ?? null, network: terms.network ?? null, asset: terms.asset ?? null,
    payTo: terms.payTo ?? null,
    maxTimeoutSeconds: Number.isFinite(Number(terms.maxTimeoutSeconds)) ? Number(terms.maxTimeoutSeconds) : null
  };
}

export function atomicToUnits(amountAtomic, decimals) {
  if (!/^\d+$/.test(String(amountAtomic)) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new TypeError('amountAtomic must be an integer string and decimals must be an integer from 0 to 18');
  }
  const amount = BigInt(amountAtomic);
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = amount % base;
  return Number(`${whole}.${fraction.toString().padStart(decimals, '0') || '0'}`);
}

function extractArtifacts(body) {
  const artifacts = body?.result?.artifacts ?? body?.result?.task?.artifacts ?? body?.artifacts ?? [];
  if (!Array.isArray(artifacts)) return [];
  return artifacts.map((artifact, index) => {
    const parts = Array.isArray(artifact?.parts) ? artifact.parts : [];
    const text = parts.filter((part) => part?.kind === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
    return {
      id: artifact?.artifactId ?? artifact?.id ?? `artifact-${index + 1}`,
      name: artifact?.name ?? null,
      description: artifact?.description ?? null,
      text,
      hasNonTextParts: parts.some((part) => part?.kind !== 'text')
    };
  });
}

/** Read the status and returned artifacts for an existing A2A task. This is read-only. */
export async function getProviderTask({ agent, taskId, fetchImpl = fetch, timeoutMs = 15000 }) {
  const handle = safeHandle(agent?.handle);
  if (typeof taskId !== 'string' || !taskId.trim()) throw new TypeError('taskId is required');
  const origin = `https://${handle}.${DEFAULT_DOMAIN}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const discovered = await discoverA2AInterface({ origin, fetchImpl, signal: controller.signal });
    if (discovered.error) return { status: 'endpoint_discovery_failed', provider: handle, reason: discovered.error, observations: discovered.observations };
    const id = `workrelay-get-task-${createRequestSuffix()}`;
    const response = await fetchImpl(discovered.endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'A2A-Version': discovered.protocolVersion },
      body: JSON.stringify({ jsonrpc: '2.0', id, method: 'GetTask', params: { id: taskId } }),
      signal: controller.signal
    });
    const body = parseJsonText(await response.text());
    if (!response.ok || body?.error) {
      return { status: 'task_lookup_failed', provider: handle, taskId, httpStatus: response.status, reason: body?.error?.message ?? `Task lookup returned HTTP ${response.status}`, responseBody: body };
    }
    const task = body?.result?.task ?? body?.result ?? body?.task ?? {};
    const taskStatus = task?.status?.state ?? body?.result?.status?.state ?? body?.status?.state ?? null;
    return {
      status: 'task_retrieved', provider: handle, taskId,
      taskStatus,
      artifacts: extractArtifacts(body),
      lastUpdatedAt: task?.status?.timestamp ?? task?.lastUpdatedAt ?? null,
      rawTask: task
    };
  } catch (error) {
    return { status: error?.name === 'AbortError' ? 'timeout' : 'request_failed', provider: handle, taskId, reason: error.message };
  } finally {
    clearTimeout(timeout);
  }
}


function decimalToAtomic(value, decimals = 6) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new TypeError('Invalid asset decimals');
  const text = String(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new TypeError('Price must be a non-negative decimal amount');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new TypeError('Price has more precision than the payment asset supports');
  return (BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((fraction + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

function extractCommissionTask(body) {
  const result = body?.result ?? {};
  const task = result?.task ?? result;
  const taskId = task?.id ?? task?.taskId ?? result?.taskId ?? body?.taskId;
  const state = task?.status?.state ?? result?.status?.state ?? null;
  return { taskId: typeof taskId === 'string' ? taskId : null, state };
}

/**
 * Create a real A2A/x402 commissioner. It deliberately contains no wallet or
 * key-management code: the host must inject an authorizer that returns a
 * signed X-PAYMENT value only after checking the authenticated approval context.
 * The returned payment proof is never persisted or logged by this adapter.
 */
export function createNearA2ACommissioner({
  paymentAuthorizer,
  allowedAssets = [],
  allowedNetworks = [],
  allowedAssetsByNetwork = null,
  allowedSchemes = [X402_SCHEME],
  paymentHeaderName = 'X-PAYMENT',
  assetDecimals = 6,
  fetchImpl = fetch,
  timeoutMs = 30000
} = {}) {
  if (typeof paymentAuthorizer !== 'function') throw new TypeError('A paymentAuthorizer callback is required; no implicit wallet signing is available');
  if (!Array.isArray(allowedAssets) || !allowedAssets.length) throw new TypeError('An explicit payment asset allowlist is required');
  if (!Array.isArray(allowedNetworks) || !allowedNetworks.length) throw new TypeError('An explicit payment network allowlist is required');
  if (!['X-PAYMENT', 'PAYMENT-SIGNATURE'].includes(paymentHeaderName)) throw new TypeError('Unsupported x402 payment header name');

  return {
    async commission({ provider, brief, acceptanceCriteria, price, currency, paymentTerms, paymentChallenge, quoteReceivedAt, idempotencyKey, a2aRequestPayload, providerEndpoint, approval, executionId, packageId }) {
      let controller = null;
      let timeout = null;
      let paymentRequestStarted = false;
      try {
        const handle = safeHandle(provider);
        if (!approval?.confirmed || !approval?.proposalId || !approval?.approvedBy) throw new Error('Authenticated proposal approval context is required');
        if (currency !== 'USDC') throw new Error('A2A x402 commissioner currently supports USDC only');
        const networkAssets = allowedAssetsByNetwork && typeof allowedAssetsByNetwork === 'object'
          ? (allowedAssetsByNetwork[paymentTerms?.network] ?? [])
          : allowedAssets;
        if (!paymentTerms?.valid || !allowedSchemes.includes(paymentTerms.scheme) || !allowedNetworks.includes(paymentTerms.network) || !networkAssets.some((asset) => String(asset).toLowerCase() === String(paymentTerms.asset).toLowerCase())) {
          throw new Error('Payment terms are not valid under the configured per-network x402 allowlist');
        }
        if (!paymentTerms.payTo || !paymentTerms.amountAtomic || !Number.isFinite(Number(paymentTerms.maxTimeoutSeconds))) throw new Error('Payment terms are incomplete');
        const expectedAtomic = decimalToAtomic(price, assetDecimals);
        if (expectedAtomic !== String(paymentTerms.amountAtomic)) throw new Error('Approved price does not exactly match the quoted atomic payment amount');
        if (!a2aRequestPayload || a2aRequestPayload.method !== 'SendMessage' || a2aRequestPayload.jsonrpc !== '2.0') {
          throw new Error('Original unpaid A2A quote request is missing; refusing to invent a paid request');
        }
        if (paymentChallenge?.x402Version !== 2 || !selectedRequirementMatches(paymentChallenge, paymentTerms)) {
          throw new Error('The selected terms are not bound to the original x402 v2 payment challenge');
        }
        if (!executionId || !packageId || !approval.proposalFingerprint) throw new Error('Execution, package and proposal fingerprint bindings are required');
        const origin = `https://${handle}.${DEFAULT_DOMAIN}`;
        controller = new AbortController();
        timeout = setTimeout(() => controller.abort(), timeoutMs);
        const discovered = await discoverA2AInterface({ origin, fetchImpl, signal: controller.signal });
        if (discovered.error) throw new Error(discovered.error);
        if (providerEndpoint && discovered.endpoint !== providerEndpoint) throw new Error('Provider A2A endpoint changed since quote; fresh approval and quote required');

        const authorization = await paymentAuthorizer({
          provider: handle,
          paymentTerms: structuredClone(paymentTerms),
          paymentChallenge: structuredClone(paymentChallenge),
          quoteReceivedAt,
          a2aRequestPayload: structuredClone(a2aRequestPayload),
          providerEndpoint: discovered.endpoint,
          executionId, packageId,
          amountAtomic: expectedAtomic,
          price: Number(price),
          currency,
          idempotencyKey,
          approval: structuredClone(approval),
          purpose: 'NEAR Agent Market A2A x402 provider commission'
        });
        const paymentHeader = authorization?.paymentHeader;
        if (typeof paymentHeader !== 'string' || !paymentHeader.trim()) throw new Error('Payment authorizer did not return a signed X-PAYMENT value');

        const paidRequest = {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'A2A-Version': discovered.protocolVersion,
            [paymentHeaderName]: paymentHeader
          },
          body: JSON.stringify(a2aRequestPayload),
          signal: controller.signal
        };
        // Set immediately before crossing the network boundary. Any failure from
        // this point onward is ambiguous, even when fetch throws before a response.
        paymentRequestStarted = true;
        const response = await fetchImpl(discovered.endpoint, paidRequest);
        const body = parseJsonText(await response.text());
        if (response.status >= 400) {
          // The signed X-PAYMENT header has crossed the network boundary. An HTTP
          // rejection does not establish that no intermediary processed payment.
          return {
            status: 'outcome_unknown',
            reason: body?.error?.message ?? body?.message ?? `Provider returned HTTP ${response.status} after payment authorization; settlement and task creation require reconciliation`,
            httpStatus: response.status,
            paymentMayHaveBeenSent: true
          };
        }
        if (!response.ok) throw new Error(`Ambiguous provider response after payment authorization (HTTP ${response.status})`);
        const task = extractCommissionTask(body);
        if (!task.taskId) throw new Error('Paid A2A response did not include a verifiable task ID; reconcile before retrying');
        return {
          status: 'commissioned', taskId: task.taskId,
          paymentStatus: 'unknown',
          paymentMode: 'x402_delivery_escrow',
          paymentEvidence: response.headers?.get?.('PAYMENT-RESPONSE') ?? response.headers?.get?.('X-PAYMENT-RESPONSE') ?? null,
          providerTaskState: task.state,
          artifacts: extractArtifacts(body),
          endpoint: discovered.endpoint,
          paymentReceipt: body?.result?.metadata?.['x402.payment.response'] ?? body?.metadata?.['x402.payment.response'] ?? null
        };
      } catch (error) {
        if (!paymentRequestStarted) {
          return { status: 'rejected_before_payment', reason: error.message, paymentMayHaveBeenSent: false };
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
  };
}

function createRequestSuffix() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
