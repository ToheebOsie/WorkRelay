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

test('the review UI makes the evidence gate and any override visible and requires a written reason', () => {
  assert.match(app, /data-evidence-gate/);
  assert.match(app, /Accept with documented evidence override/);
  assert.match(app, /evidenceOverrideReason/);
  assert.match(app, /Accepted with an evidence override/);
  assert.match(app, /Accepted with an evidence override: \$\{report\.evidenceOverrides/);
});

test('primary workflow includes accessible skip navigation, field guidance and live status announcements', () => {
  assert.match(html, /class="skip-link" href="#main-content"/);
  assert.match(html, /<main id="main-content">/);
  assert.match(html, /aria-describedby="objective-help"/);
  assert.match(html, /id="objective-help"/);
  assert.match(html, /id="notice" class="notice" role="status" aria-live="polite"/);
  assert.match(html, /id="execution-warning" class="notice warn" role="status" aria-live="polite"/);
});

test('global UI sizing, responsive layouts and reduced-motion preferences are defined', () => {
  assert.match(css, /textarea, input, select\s*\{[^}]*font:\s*400 16px/);
  assert.match(css, /@media\s*\(max-width:\s*560px\)/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /button:focus-visible, a:focus-visible, summary:focus-visible/);
});


test('lifecycle notes remain readable inside light delivery cards', () => {
  const note = rule('.execution-card .lifecycle-note');
  const foreground = colorFrom(note, 'color');
  assert.ok(contrast(foreground, '#ffffff') >= 4.5, 'lifecycle notes on white cards must meet WCAG AA contrast');
  assert.match(note, /font-size:\s*14px/);
});

test('compact workflow labels and supporting quote details are not rendered as tiny text', () => {
  const labels = css.match(/\.step,\s*\.metric-label,\s*\.credit-stats small,\s*\.subhead span,\s*\.package-index,\s*\.status,\s*\.workflow-number,\s*\.workflow-state\s*\{([^}]*)\}/s);
  assert.ok(labels, 'the compact workflow labels should share an explicit readable-size rule');
  assert.match(labels[1], /font-size:\s*12px/);
  assert.match(rule('.quote-line small'), /font-size:\s*13px/);
  assert.match(rule('.check-row small'), /font-size:\s*13px/);
});

test('long quote labels can wrap instead of forcing horizontal overflow', () => {
  assert.match(css, /\.quote-line\s*>\s*span,\s*\.quote-package header\s*>\s*span\s*\{[^}]*overflow-wrap:\s*anywhere/);
});


test('evidence checks, source assessments, and claim assessments are collapsible native disclosures', () => {
  assert.match(app, /function evidenceDisclosure\(/);
  assert.match(app, /Verification checks/);
  assert.match(app, /Source assessments/);
  assert.match(app, /Claim assessments/);
  assert.match(app, /<details class="evidence-item">/);
  assert.match(app, /<summary><span class="evidence-item-title">/);
  assert.match(css, /\.execution-card summary:focus-visible/);
});

test('demo scenario and replay controls live in a separate collapsible simulation toolbar', () => {
  const toolbar = html.indexOf('<details id="sandbox-controls" class="demo-tools hidden">');
  const delivery = html.indexOf('<section id="execution"');
  assert.ok(toolbar >= 0 && delivery > toolbar, 'the demo toolbar should precede and sit outside the delivery section');
  assert.match(html, /SIMULATION ONLY · NO REAL FUNDS/);
  assert.match(html, /These controls never contact a provider or payment route/);
  assert.match(app, /button\.onclick = \(\) => runSandboxScenario/);
  assert.doesNotMatch(app, /sandboxControls\.querySelectorAll\('\.sandbox-scenario'\)\.forEach\(\(button\) => button\.addEventListener/);
});

test('elements marked hidden are actually removed from layout and keyboard navigation', () => {
  assert.match(css, /\.hidden\s*\{\s*display:\s*none\s*!important\s*;/);
});

test('long execution and lifecycle deliverables wrap on narrow screens', () => {
  assert.match(css, /\.execution-card pre,\s*\.lifecycle-deliverable\s*\{[^}]*white-space:\s*pre-wrap/);
  assert.match(css, /\.execution-card pre,\s*\.lifecycle-deliverable\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('programmatic section scrolling respects reduced-motion preferences', () => {
  assert.match(app, /function scrollToSection\(/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(app, /element\.scrollIntoView\(\{ behavior: reduceMotion \? 'auto' : 'smooth'/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('the hero is followed by correctly nested section headings', () => {
  assert.match(html, /<h1>[\s\S]*?<\/h1>[\s\S]*?<section class="credit-banner"[\s\S]*?<h2>\$1,000 in free demo credits<\/h2>/);
});

test('demo scenario and reset requests are mutually exclusive until the active request settles', () => {
  assert.equal((app.match(/if \(sandboxBusy\) return;/g) || []).length, 2);
  assert.equal((app.match(/setSandboxControlsDisabled\(true\)/g) || []).length, 2);
  assert.match(app, /finally\s*\{\s*sandboxBusy = false;\s*setSandboxControlsDisabled\(false\);/);
});


test('mobile network metadata remains readable at compact widths', () => {
  assert.match(css, /@media\s*\(max-width:\s*560px\)\s*\{\s*\.network\s*\{\s*font-size:\s*11px/);
});


test('evidence and demo disclosure summaries provide at least 44px touch targets', () => {
  for (const selector of ['.evidence-disclosure > summary', '.evidence-item > summary', '.demo-tools-summary']) {
    assert.match(rule(selector), /min-height:\s*(?:4[4-9]|[5-9]\d|\d{3,})px/ , `${selector} should remain at least 44px tall`);
  }
});


test('evidence packet and quality policy sections expose semantic headings', () => {
  assert.match(app, /<h3 class="evidence-heading">Evidence packet:/);
  assert.match(app, /<h3 class="evidence-heading">Evidence quality policy:/);
});
