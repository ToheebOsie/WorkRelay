import { createHash } from 'node:crypto';

const MAX_ARTIFACT_CHARS = 200_000;
// Control chars (except \n and \t), zero-width and bidi-override characters.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;
const INJECTION_PATTERNS = [
  [/ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i, 'instruction_override_phrase'],
  [/(system|developer) (prompt|message|instruction)s?\s*[:=]/i, 'system_prompt_reference'],
  [/\b(send|transfer|pay|wire)\b[^.\n]{0,60}\b(usdc|near|funds?|wallet)\b/i, 'payment_instruction'],
  [/\b(change|update|replace)\b[^.\n]{0,40}\b(recipient|payto|wallet address|budget)\b/i, 'payment_or_budget_change_request'],
  [/\b(approve|authori[sz]e)\b[^.\n]{0,40}\b(payment|spend|commission|hire)\b/i, 'authorization_request']
];

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function sanitizeProviderText(input) {
  const warnings = [];
  let text = typeof input === 'string' ? input : '';
  const before = text;
  text = text.replace(/\r\n?/g, '\n').replace(UNSAFE_CHARS, '');
  if (text !== before.replace(/\r\n?/g, '\n')) warnings.push('unsafe_characters_removed');
  if (text.length > MAX_ARTIFACT_CHARS) { text = text.slice(0, MAX_ARTIFACT_CHARS); warnings.push('truncated_to_size_limit'); }
  return { text, warnings };
}

/** Flags suspicious content for human attention. Flagging never changes behaviour: provider text is inert data. */
export function detectInjectionSignals(text) {
  return INJECTION_PATTERNS.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
}

function classify(part, text) {
  const mime = String(part?.mediaType ?? part?.mimeType ?? '').toLowerCase();
  if (mime.includes('markdown')) return 'markdown';
  if (mime.includes('json')) return 'json';
  if (/^\s*#{1,6}\s+\S/m.test(text)) return 'markdown';
  return 'text';
}

/**
 * Normalise A2A task artifacts into untrusted, hashed, provenance-tagged records.
 * Accepts raw A2A artifacts ({artifactId,name,parts:[{kind|text|data|file}]}) or the
 * pre-extracted shape {id,name,text}. Never throws on malformed provider data.
 */
export function parseTaskArtifacts(rawArtifacts, { provider, taskId, retrievedAt = new Date().toISOString(), source = 'a2a:GetTask' } = {}) {
  const warnings = [];
  const list = Array.isArray(rawArtifacts) ? rawArtifacts : [];
  if (rawArtifacts != null && !Array.isArray(rawArtifacts)) warnings.push('artifacts_not_an_array');
  const artifacts = [];
  list.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') { warnings.push(`artifact_${index + 1}_malformed`); return; }
    const parts = Array.isArray(raw.parts) ? raw.parts : (typeof raw.text === 'string' ? [{ text: raw.text }] : []);
    const pieces = []; const artifactWarnings = []; let kind = 'text';
    for (const part of parts) {
      if (part && typeof part.text === 'string') {
        const clean = sanitizeProviderText(part.text); artifactWarnings.push(...clean.warnings);
        pieces.push(clean.text); kind = classify(part, clean.text);
      } else if (part && part.data !== undefined && part.data !== null) {
        let rendered;
        try { rendered = JSON.stringify(part.data, null, 2); } catch { artifactWarnings.push('data_part_not_serialisable'); continue; }
        const clean = sanitizeProviderText(rendered); artifactWarnings.push(...clean.warnings);
        pieces.push(clean.text); kind = 'json';
      } else if (part && (part.file || part.url || part.raw)) {
        artifactWarnings.push('file_part_not_ingested'); // binary/remote files are never fetched or stored
      } else artifactWarnings.push('unrecognised_part_ignored');
    }
    const content = pieces.join('\n\n').trim();
    if (!content) { warnings.push(`artifact_${index + 1}_empty`); return; }
    const signals = detectInjectionSignals(content);
    if (signals.length) artifactWarnings.push(...signals.map((s) => `possible_prompt_injection:${s}`));
    artifacts.push({
      id: String(raw.artifactId ?? raw.id ?? `artifact-${index + 1}`).slice(0, 200),
      name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : null,
      kind, content, bytes: Buffer.byteLength(content), contentHash: sha256(content), warnings: [...new Set(artifactWarnings)],
      provenance: { provider: provider ?? null, taskId: taskId ?? null, retrievedAt, source, trust: 'untrusted_provider_content' }
    });
  });
  const combinedText = artifacts.map((a) => a.content).join('\n\n');
  return {
    artifacts, combinedText, combinedHash: combinedText ? sha256(combinedText) : null,
    missing: artifacts.length === 0, warnings: [...new Set([...warnings, ...artifacts.flatMap((a) => a.warnings)])]
  };
}
