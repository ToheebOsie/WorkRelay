import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const integrationPath = path.join(root, "contracts/integration-tests/tests/escrow_sandbox.rs");
const scriptPath = path.join(root, "scripts/test-near-contracts.sh");

test("NEAR Sandbox transaction results are explicitly consumed or asserted", async () => {
  const source = await readFile(integrationPath, "utf8");
  const transactionCalls = (source.match(/\.transact\(\)/g) ?? []).length;
  const successfulOutcomes = (source.match(/\.into_result\(\)/g) ?? []).length;
  const expectedFailures = (source.match(/^\s*expect_failure\(/gm) ?? []).length;
  const failedReceiptAssertions = (source.match(/outcome\.failures\(\)/g) ?? []).length;

  assert.equal(transactionCalls, 82, "update this guard when Sandbox transaction coverage changes");
  assert.equal(successfulOutcomes, 66, "every successful transaction must consume into_result()");
  assert.equal(expectedFailures, 15, "every expected contract rejection must assert is_failure()");
  assert.equal(failedReceiptAssertions, 1, "failed FT withdrawal must assert its failed receipt");
  assert.doesNotMatch(source, /\.is_err\(\)/, "RPC errors are not proof of an on-chain contract rejection");
});

test("full NEAR gate runs integration-test Clippy with warnings denied", async () => {
  const script = await readFile(scriptPath, "utf8");
  assert.match(
    script,
    /cargo clippy --locked -p workrelay-near-integration --all-targets -- -D warnings/,
  );
});


test("Rust formatting is explicit and the host gate is non-mutating", async () => {
  const hostScript = await readFile(path.join(root, "scripts/check-near-host.sh"), "utf8");
  const formatter = await readFile(path.join(root, "scripts/format-near-contracts.sh"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

  assert.match(hostScript, /cargo fmt --all -- --check/);
  assert.doesNotMatch(hostScript, /^cargo fmt --all\s*$/m);
  assert.match(formatter, /^cargo fmt --all\s*$/m);
  assert.match(formatter, /SHA256SUMS\.txt/);
  assert.match(formatter, /Cargo\.lock/);
  assert.equal(packageJson.scripts["format:near-contracts"], "bash scripts/format-near-contracts.sh");
});

test("a requested revision cannot outlive delivery deadline without entering dispute", async () => {
  const contract = await readFile(path.join(root, "contracts/job-escrow/src/lib.rs"), "utf8");
  const integration = await readFile(integrationPath, "utf8");
  const requestRevision = contract.match(/pub fn request_revision\([\s\S]*?(?=\n    pub fn )/)?.[0] ?? "";
  const revisionExpiry = contract.match(/pub fn mark_revision_expired_disputed\([\s\S]*?(?=\n    pub fn )/)?.[0] ?? "";

  assert.match(requestRevision, /delivery_deadline_ns/);
  assert.match(revisionExpiry, /JobState::RevisionRequested/);
  assert.match(revisionExpiry, /delivery_deadline_ns/);
  assert.match(revisionExpiry, /job\.state = JobState::Disputed/);
  assert.doesNotMatch(revisionExpiry, /move_unsettled_to_(buyer|provider)_claim/);
  assert.match(integration, /sandbox_revision_deadline_expiry_uses_dispute_path/);
  assert.match(integration, /mark_revision_expired_disputed/);
});

