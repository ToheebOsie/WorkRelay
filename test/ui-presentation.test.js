import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function rgb(hex) {
  const normalized = hex.replace('#', '').trim();
  assert.match(normalized, /^[0-9a-f]{6}$/i, `Expected a six-digit hex color, got ${hex}`);
  return [0, 2, 4].map((offset) => parseInt(normalized.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
}

function contrast(foreground, background) {
  const [a, b] = [rgb(foreground), rgb(background)].map((channels) =>
    channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
  const matches = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'gs'))];
  assert.ok(matches.length, `Missing CSS rule for ${selector}`);
  return matches.at(-1)[1];
}

function colorFrom(cssBody, property) {
  const match = cssBody.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `Missing explicit ${property} in rule: ${cssBody}`);
  return match[1];
}

test('evidence and structural evaluation panels use readable dark text on light surfaces', () => {
  const card = rule('.execution-card');
  const evaluation = rule('.execution-card .evaluation');
  const header = rule('.execution-card header p');
  const evaluationText = rule('.execution-card .evaluation p');
  const checkText = rule('.execution-card .evaluation .check-row span');
  const checkDetail = rule('.execution-card .evaluation .check-row small');

  const cardBg = colorFrom(card, 'background');
  const cardText = colorFrom(card, 'color');
  const evaluationBg = colorFrom(evaluation, 'background');
  const evaluationForeground = colorFrom(evaluation, 'color');

  assert.ok(contrast(cardText, cardBg) >= 4.5, 'execution card text must meet WCAG AA normal-text contrast');
  assert.ok(contrast(colorFrom(header, 'color'), cardBg) >= 4.5, 'execution card metadata must meet WCAG AA contrast');
  assert.ok(contrast(evaluationForeground, evaluationBg) >= 4.5, 'evaluation text must meet WCAG AA normal-text contrast');
  assert.ok(contrast(colorFrom(evaluationText, 'color'), evaluationBg) >= 4.5, 'evaluation explanations must meet WCAG AA contrast');
  assert.ok(contrast(colorFrom(checkText, 'color'), evaluationBg) >= 4.5, 'evidence check names must meet WCAG AA contrast');
  assert.ok(contrast(colorFrom(checkDetail, 'color'), evaluationBg) >= 4.5, 'evidence check details must meet WCAG AA contrast');
});

test('review buttons remain legible and keyboard focus is visible on light execution cards', () => {
  const acceptButton = rule('.execution-card .review-actions .secondary');
  const revisionButton = rule('.execution-card .review-actions .ghost');
  assert.equal(colorFrom(acceptButton, 'color').toLowerCase(), '#101820');
  assert.equal(colorFrom(revisionButton, 'color').toLowerCase(), '#26313a');
  assert.match(css, /\.execution-card button:focus-visible\s*\{[^}]*outline:\s*3px solid #[0-9a-f]{6}/i);
});

test('a failed live discovery attempt does not leave a stale simulated mode pill', () => {
  assert.match(app, /const submittedMode = \$\('#mode'\)\.value;/);
  assert.match(app, /if \(!currentSession\)\s*\{\s*\$\('#mode-pill'\)\.textContent = submittedMode === 'live'\s*\? 'LIVE DISCOVERY FAILED'/s);
  assert.match(app, /\$\('#mode-pill'\)\.dataset\.state = 'error';/);
});

test('sandbox reset explains that already-consumed simulated quote credits are not restored', () => {
  assert.match(html, /Reset clears execution state; it does not restore simulated credits already consumed by quote comparison\./);
});

test('execution UI exposes evidence quality policy, review status and claim-level corroboration', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /Evidence quality policy:/);
  assert.match(source, /Human review/);
  assert.match(source, /corroboration/);
  assert.match(source, /Supporting sources:/);
  assert.match(source, /publisher group/);
  assert.match(source, /authorityRegistryStatus/);
  assert.match(source, /possible shared\/derivative text/);
  assert.match(source, /repeated attribution\/origin label/);
  assert.match(source, /claim\.conflictAssessment\?\.status/);
  assert.match(source, /source\.attributionSignals/);
  assert.match(source, /signal\.type/);
  assert.match(source, /maxRetrievalAgeDays/);
});

test('execution UI exposes current-regulatory-status review results', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(source, /current-law status/);
  assert.match(source, /regulatoryCurrentStatus\?\.status/);
});
