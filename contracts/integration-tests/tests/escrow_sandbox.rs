use anyhow::{Context, Result};
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::fs;

fn one_yocto() -> NearToken {
    NearToken::from_yoctonear(1)
}
const WRT_AMOUNT: &str = "100000000"; // 100 WRT at 6 decimals.
const HASH_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HASH_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HASH_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

fn expect_failure(outcome: ExecutionFinalResult, action: &str) -> Result<()> {
    if outcome.is_failure() {
        Ok(())
    } else {
        anyhow::bail!(
            "{action} unexpectedly succeeded; logs: {:?}",
            outcome.logs()
        )
    }
}

fn wasm_from_env(name: &str) -> Result<Vec<u8>> {
    let path = std::env::var(name)
        .with_context(|| format!("{name} must point to a compiled WASM file"))?;
    fs::read(&path).with_context(|| format!("unable to read contract WASM: {path}"))
}

async fn setup() -> Result<(
    Worker<Sandbox>,
    Contract,
    Contract,
    Account,
    Account,
    Account,
    Account,
)> {
    let worker = near_workspaces::sandbox().await?;
    let buyer = worker.dev_create_account().await?;
    let provider = worker.dev_create_account().await?;
    let resolver = worker.dev_create_account().await?;
    let stranger = worker.dev_create_account().await?;

    let ft_wasm = wasm_from_env("WORKRELAY_TEST_TOKEN_WASM")?;
    let ft = worker.dev_deploy(&ft_wasm).await?;
    ft.call("new")
        .args_json(json!({ "owner_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let escrow_wasm = wasm_from_env("WORKRELAY_JOB_ESCROW_WASM")?;
    let escrow = worker.dev_deploy(&escrow_wasm).await?;
    escrow
        .call("new")
        .args_json(json!({ "allowed_ft_contract_id": ft.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // Register every account needed for NEP-141 transfers. The buyer was
    // registered during token initialization; the escrow must be registered
    // before it can receive ft_transfer_call deposits.
    for account_id in [provider.id(), resolver.id(), stranger.id(), escrow.id()] {
        buyer
            .call(ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": account_id, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .map(|_| ())
            .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    }

    buyer
        .call(ft.id(), "mint")
        .args_json(json!({ "receiver_id": buyer.id(), "amount": "10000000000" }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(ft.id(), "mint")
        .args_json(json!({ "receiver_id": provider.id(), "amount": "10000000000" }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    Ok((worker, ft, escrow, buyer, provider, resolver, stranger))
}

fn terms(
    job_id: &str,
    buyer: &Account,
    provider: &Account,
    resolver: &Account,
    ft: &Contract,
    revision_limit: u8,
) -> Value {
    // Far-future ordered deadlines keep this base integration test deterministic.
    json!({
        "schema": "workrelay.testnet-escrow-terms.v1",
        "jobId": job_id,
        "buyerAccountId": buyer.id(),
        "providerAccountId": provider.id(),
        "agentMarketHandle": "controlled-workrelay-demo-provider",
        "briefHash": HASH_A,
        "acceptanceCriteriaHash": HASH_B,
        "verifierName": "workrelay.structural",
        "verifierVersion": "1.0.0",
        "ftContractId": ft.id(),
        "tokenDecimals": 6,
        "atomicAmount": WRT_AMOUNT,
        "providerAcceptanceDeadlineNs": "1900000000000000000",
        "deliveryDeadlineNs": "1900003600000000000",
        "buyerReviewDeadlineNs": "1900007200000000000",
        "revisionLimit": revision_limit,
        "resolverAccountId": resolver.id(),
        "disputePolicyVersion": "manual-review.v1"
    })
}

// Test fixture builder: one explicit parameter per immutable term keeps the
// call sites readable, so the argument-count lint is intentionally allowed here.
#[allow(clippy::too_many_arguments)]
fn terms_with_deadlines(
    job_id: &str,
    buyer: &Account,
    provider: &Account,
    resolver: &Account,
    ft: &Contract,
    revision_limit: u8,
    accept_by_ns: u64,
    deliver_by_ns: u64,
    review_by_ns: u64,
) -> Value {
    json!({
        "schema": "workrelay.testnet-escrow-terms.v1",
        "jobId": job_id,
        "buyerAccountId": buyer.id(),
        "providerAccountId": provider.id(),
        "agentMarketHandle": "controlled-workrelay-demo-provider",
        "briefHash": HASH_A,
        "acceptanceCriteriaHash": HASH_B,
        "verifierName": "workrelay.structural",
        "verifierVersion": "1.0.0",
        "ftContractId": ft.id(),
        "tokenDecimals": 6,
        "atomicAmount": WRT_AMOUNT,
        "providerAcceptanceDeadlineNs": accept_by_ns.to_string(),
        "deliveryDeadlineNs": deliver_by_ns.to_string(),
        "buyerReviewDeadlineNs": review_by_ns.to_string(),
        "revisionLimit": revision_limit,
        "resolverAccountId": resolver.id(),
        "disputePolicyVersion": "manual-review.v1"
    })
}

async fn advance_past(worker: &Worker<Sandbox>, deadline_ns: u64) -> Result<()> {
    for _ in 0..40 {
        if worker.view_block().await?.timestamp() > deadline_ns {
            return Ok(());
        }
        worker.fast_forward(100).await?;
    }
    anyhow::bail!("NEAR Sandbox did not advance beyond deadline {deadline_ns}")
}

async fn create_and_fund(
    escrow: &Contract,
    ft: &Contract,
    buyer: &Account,
    terms: Value,
) -> Result<String> {
    let job_id = terms["jobId"].as_str().unwrap().to_string();
    buyer
        .call(escrow.id(), "create_job")
        .args_json(json!({ "terms": terms }))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(ft.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": escrow.id(),
            "amount": WRT_AMOUNT,
            "memo": "WorkRelay testnet escrow deposit",
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string()
        }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    Ok(job_id)
}

async fn view_json(contract: &Contract, method: &str, args: Value) -> Result<Value> {
    Ok(contract
        .view(method)
        .args_json(args)
        .await?
        .json::<Value>()?)
}

#[tokio::test]
async fn sandbox_success_revision_dispute_refund_and_role_boundaries() -> Result<()> {
    let (_worker, ft, escrow, buyer, provider, resolver, stranger) = setup().await?;

    let metadata = ft.view("ft_metadata").await?.json::<Value>()?;
    assert_eq!(metadata["symbol"], "WRT");
    assert_eq!(metadata["decimals"], 6);
    let config = view_json(&escrow, "get_contract_config", json!({})).await?;
    assert_eq!(config["tokenDecimals"], 6);
    assert_eq!(config["mainnetEnabled"], false);
    assert_eq!(config["allowedFtContractId"], ft.id().as_str());

    // Canonical terms preview and persisted digest must agree.
    let success_terms = terms("job-success", &buyer, &provider, &resolver, &ft, 1);
    let preview: String = escrow
        .view("preview_terms_hash")
        .args_json(json!({ "terms": success_terms.clone() }))
        .await?
        .json()?;
    let success_id = create_and_fund(&escrow, &ft, &buyer, success_terms).await?;
    let success_job = view_json(&escrow, "get_job", json!({ "job_id": success_id })).await?;
    assert_eq!(success_job["termsHash"], preview);
    assert_eq!(success_job["state"], "funded");

    // Buyer cannot act as provider; the assigned provider can.
    let buyer_as_provider = buyer
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": success_id }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(buyer_as_provider, "buyer must not accept as provider")?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": success_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": success_id, "artifact_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // Submission alone is not acceptance or payment. An early pre-submission
    // refund trigger must fail once an artifact has been submitted.
    let premature_refund = stranger
        .call(escrow.id(), "make_pre_submission_refund_claimable")
        .args_json(json!({ "job_id": success_id }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        premature_refund,
        "a submitted job cannot enter the pre-submission refund path",
    )?;
    let submitted = view_json(&escrow, "get_job", json!({ "job_id": success_id })).await?;
    assert_eq!(submitted["state"], "submitted");
    assert_eq!(submitted["claimableProvider"], "0");

    buyer
        .call(escrow.id(), "accept_delivery")
        .args_json(json!({ "job_id": success_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let accepted = view_json(&escrow, "get_job", json!({ "job_id": success_id })).await?;
    assert_eq!(accepted["state"], "accepted");
    assert_eq!(accepted["claimableProvider"], WRT_AMOUNT);
    let ft_balance: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": escrow.id() }))
        .await?
        .json()?;
    assert_eq!(
        ft_balance, WRT_AMOUNT,
        "escrow FT balance covers outstanding liability before withdrawal"
    );

    // Only provider can withdraw. Pull transfer is finalized by its private callback.
    let unauthorized_withdraw = stranger
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": success_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?;
    expect_failure(unauthorized_withdraw, "only the claim owner may withdraw")?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": success_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let provider_claim: Value = view_json(
        &escrow,
        "get_claim",
        json!({ "job_id": success_id, "account_id": provider.id() }),
    )
    .await?;
    assert_eq!(provider_claim["claimable"], "0");
    assert_eq!(provider_claim["inFlight"], "0");
    let liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(liabilities["totalLiability"], "0");
    assert_eq!(liabilities["accountingInvariantHolds"], true);
    let provider_double_withdraw = provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": success_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        provider_double_withdraw,
        "a terminal claim cannot be withdrawn twice",
    )?;
    buyer
        .call(escrow.id(), "archive_terminal_job")
        .args_json(json!({ "job_id": success_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let archived = view_json(&escrow, "get_job", json!({ "job_id": success_id })).await?;
    assert!(
        archived.is_null(),
        "archived job must be removed from live job map"
    );
    let id_tombstone: bool = escrow
        .view("is_job_id_used")
        .args_json(json!({ "job_id": "job-success" }))
        .await?
        .json()?;
    assert!(
        id_tombstone,
        "archival must retain a permanent job-ID tombstone"
    );

    // Excess create-job storage deposits and the measured archive refund are
    // accumulated as a separate native-NEAR pull claim and finalized by callback.
    let native_refund_before: Value = view_json(
        &escrow,
        "get_native_refund",
        json!({ "account_id": buyer.id() }),
    )
    .await?;
    let native_refund_amount = native_refund_before["claimable"]
        .as_str()
        .unwrap()
        .parse::<u128>()?;
    assert!(
        native_refund_amount > 0,
        "buyer should have a native storage refund claim"
    );
    buyer
        .call(escrow.id(), "withdraw_storage_refund")
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let native_refund_after: Value = view_json(
        &escrow,
        "get_native_refund",
        json!({ "account_id": buyer.id() }),
    )
    .await?;
    assert_eq!(native_refund_after["claimable"], "0");
    assert_eq!(native_refund_after["inFlight"], "0");
    let native_liability = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(native_liability["nativeRefundLiability"], "0");

    let reused_job_id = buyer
        .call(escrow.id(), "create_job")
        .args_json(json!({ "terms": terms("job-success", &buyer, &provider, &resolver, &ft, 0) }))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?;
    expect_failure(reused_job_id, "an archived job ID must never be reusable")?;

    // One committed revision: provider must submit a new artifact digest.
    let revision_terms = terms("job-revision", &buyer, &provider, &resolver, &ft, 1);
    let revision_id = create_and_fund(&escrow, &ft, &buyer, revision_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": revision_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": revision_id, "artifact_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "request_revision")
        .args_json(json!({ "job_id": revision_id, "rationale_hash": HASH_B }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let second_revision = buyer
        .call(escrow.id(), "request_revision")
        .args_json(json!({ "job_id": revision_id, "rationale_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        second_revision,
        "cannot request second revision before resubmission",
    )?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": revision_id, "artifact_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "accept_delivery")
        .args_json(json!({ "job_id": revision_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": revision_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // Dispute allocation must total exactly the original atomic amount and only
    // the immutable resolver can make that allocation.
    let dispute_terms = terms("job-dispute", &buyer, &provider, &resolver, &ft, 0);
    let dispute_id = create_and_fund(&escrow, &ft, &buyer, dispute_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": dispute_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": dispute_id, "artifact_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "open_dispute")
        .args_json(json!({ "job_id": dispute_id, "rationale_hash": HASH_B }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let stranger_resolution = stranger.call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": dispute_id, "provider_amount": "50000000", "buyer_refund_amount": "50000000", "rationale_hash": HASH_C }))
        .max_gas().transact().await?;
    expect_failure(
        stranger_resolution,
        "only the named resolver may resolve a dispute",
    )?;
    let bad_sum = resolver.call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": dispute_id, "provider_amount": "50000000", "buyer_refund_amount": "40000000", "rationale_hash": HASH_C }))
        .max_gas().transact().await?;
    expect_failure(bad_sum, "dispute allocation must equal the escrow amount")?;
    resolver.call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": dispute_id, "provider_amount": "60000000", "buyer_refund_amount": "40000000", "rationale_hash": HASH_C }))
        .max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": dispute_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": dispute_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // Provider decline before submission enables only a buyer refund claim.
    let refund_terms = terms("job-refund", &buyer, &provider, &resolver, &ft, 0);
    let refund_id = create_and_fund(&escrow, &ft, &buyer, refund_terms).await?;
    provider
        .call(escrow.id(), "decline_job")
        .args_json(json!({ "job_id": refund_id, "rationale_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let refund_job = view_json(&escrow, "get_job", json!({ "job_id": refund_id })).await?;
    assert_eq!(refund_job["state"], "refundable");
    buyer
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": refund_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let final_liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(final_liabilities["accountingInvariantHolds"], true);
    assert_eq!(final_liabilities["totalLiability"], "0");
    Ok(())
}

#[tokio::test]
async fn sandbox_unregistered_withdrawal_recipient_restores_claim() -> Result<()> {
    let (_worker, ft, escrow, buyer, provider, resolver, _stranger) = setup().await?;

    // Force-unregister the provider before funding. The setup mints WRT to this
    // account for the wrong-sender test, so force=true burns that test balance.
    // A submitted job can still be accepted, but its FT transfer must fail and
    // the escrow callback must restore the claim.
    provider
        .call(ft.id(), "storage_unregister")
        .args_json(json!({ "force": true }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let job_terms = terms(
        "job-failed-withdrawal",
        &buyer,
        &provider,
        &resolver,
        &ft,
        0,
    );
    let job_id = create_and_fund(&escrow, &ft, &buyer, job_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": job_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": job_id, "artifact_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "accept_delivery")
        .args_json(json!({ "job_id": job_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // NEAR Workspaces reports the transaction final outcome after chained
    // callbacks. The transfer fails at the FT registration check; our callback
    // restores the claimable balance instead of reducing liability.
    let outcome = provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": job_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?;
    // The failed FT receipt must be visible in the final execution record, even
    // though the escrow callback restores the claim. The source of truth for
    // restored liability remains the contract view below.
    assert!(
        !outcome.failures().is_empty(),
        "unregistered FT recipient must produce a failed transfer receipt",
    );
    let claim = view_json(
        &escrow,
        "get_claim",
        json!({ "job_id": job_id, "account_id": provider.id() }),
    )
    .await?;
    assert_eq!(claim["claimable"], WRT_AMOUNT);
    assert_eq!(claim["inFlight"], "0");
    let liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(liabilities["totalLiability"], WRT_AMOUNT);
    assert_eq!(liabilities["accountingInvariantHolds"], true);
    Ok(())
}

#[tokio::test]
async fn sandbox_rejects_wrong_amount_sender_message_and_reused_deposit() -> Result<()> {
    let (worker, ft, escrow, buyer, provider, resolver, stranger) = setup().await?;
    let job_terms = terms("job-invalid-deposits", &buyer, &provider, &resolver, &ft, 0);
    let mut wrong_decimals = job_terms.clone();
    wrong_decimals["tokenDecimals"] = json!(18);
    let wrong_decimals_result = buyer
        .call(escrow.id(), "create_job")
        .args_json(json!({ "terms": wrong_decimals }))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        wrong_decimals_result,
        "WRT escrow must reject mismatched token decimals",
    )?;
    let job_id = create_and_fund_without_deposit(&escrow, &buyer, job_terms).await?;
    let buyer_start: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": buyer.id() }))
        .await?
        .json()?;

    // A different NEP-141 contract must not be able to fund a job, even when
    // it sends the expected buyer, amount and message.
    let other_ft_wasm = wasm_from_env("WORKRELAY_TEST_TOKEN_WASM")?;
    let other_ft = worker.dev_deploy(&other_ft_wasm).await?;
    other_ft
        .call("new")
        .args_json(json!({ "owner_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    for account_id in [buyer.id(), escrow.id()] {
        buyer
            .call(other_ft.id(), "storage_deposit")
            .args_json(json!({ "account_id": account_id, "registration_only": true }))
            .deposit(NearToken::from_millinear(100))
            .max_gas()
            .transact()
            .await?
            .into_result()
            .map(|_| ())
            .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    }
    buyer
        .call(other_ft.id(), "mint")
        .args_json(json!({ "receiver_id": buyer.id(), "amount": WRT_AMOUNT }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer.call(other_ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null,
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string() }))
        .deposit(one_yocto()).max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let wrong_ft_escrow_balance: String = other_ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": escrow.id() }))
        .await?
        .json()?;
    assert_eq!(
        wrong_ft_escrow_balance, "0",
        "non-allowlisted token deposits must be returned"
    );

    // Wrong amount is returned in full by ft_on_transfer; there is no partial escrow.
    buyer.call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": "1", "memo": null,
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string() }))
        .deposit(one_yocto()).max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let after_wrong_amount: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": buyer.id() }))
        .await?
        .json()?;
    assert_eq!(after_wrong_amount, buyer_start);

    // The provider is not the buyer named in the immutable terms.
    provider.call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null,
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string() }))
        .deposit(one_yocto()).max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // Malformed JSON and unknown message versions are both returned in full.
    buyer
        .call(ft.id(), "ft_transfer_call")
        .args_json(
            json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null, "msg": "{" }),
        )
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(ft.id(), "ft_transfer_call")
        .args_json(
            json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null,
            "msg": json!({ "schema": "wrong.v9", "jobId": job_id }).to_string() }),
        )
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let still_created = view_json(&escrow, "get_job", json!({ "job_id": job_id })).await?;
    assert_eq!(still_created["state"], "created");
    let escrow_balance_before: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": escrow.id() }))
        .await?
        .json()?;
    assert_eq!(escrow_balance_before, "0");

    // A valid exact deposit funds the job once. Reusing the same job ID cannot
    // increment liabilities a second time: the full second transfer is returned.
    buyer.call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null,
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string() }))
        .deposit(one_yocto()).max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer.call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": WRT_AMOUNT, "memo": null,
            "msg": json!({ "schema": "workrelay.escrow-deposit.v1", "jobId": job_id }).to_string() }))
        .deposit(one_yocto()).max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let funded = view_json(&escrow, "get_job", json!({ "job_id": job_id })).await?;
    assert_eq!(funded["state"], "funded");
    let liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(liabilities["totalLiability"], WRT_AMOUNT);
    assert_eq!(liabilities["accountingInvariantHolds"], true);
    let escrow_balance: String = ft
        .view("ft_balance_of")
        .args_json(json!({ "account_id": escrow.id() }))
        .await?
        .json()?;
    assert_eq!(escrow_balance, WRT_AMOUNT);
    let _ = stranger;
    Ok(())
}

async fn create_and_fund_without_deposit(
    escrow: &Contract,
    buyer: &Account,
    terms: Value,
) -> Result<String> {
    let job_id = terms["jobId"].as_str().unwrap().to_string();
    buyer
        .call(escrow.id(), "create_job")
        .args_json(json!({ "terms": terms }))
        .deposit(NearToken::from_near(2))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    Ok(job_id)
}

#[tokio::test]
async fn sandbox_deadlines_refund_only_before_submission_and_dispute_after_submission() -> Result<()>
{
    let (worker, ft, escrow, buyer, provider, resolver, stranger) = setup().await?;
    let now_ns = worker.view_block().await?.timestamp();
    let accept_by = now_ns + 120_000_000_000;
    let deliver_by = now_ns + 240_000_000_000;
    let review_by = now_ns + 360_000_000_000;

    // 1. Provider never accepts: an early refund trigger fails, then a
    // permissionless trigger after the acceptance deadline creates only the
    // buyer's refund claim.
    let no_accept_terms = terms_with_deadlines(
        "job-deadline-no-accept",
        &buyer,
        &provider,
        &resolver,
        &ft,
        0,
        accept_by,
        deliver_by,
        review_by,
    );
    let no_accept_id = create_and_fund(&escrow, &ft, &buyer, no_accept_terms).await?;
    let early_refund = stranger
        .call(escrow.id(), "make_pre_submission_refund_claimable")
        .args_json(json!({ "job_id": no_accept_id }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        early_refund,
        "refund must not be available before acceptance deadline",
    )?;
    advance_past(&worker, accept_by).await?;
    stranger
        .call(escrow.id(), "make_pre_submission_refund_claimable")
        .args_json(json!({ "job_id": no_accept_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let no_accept_job = view_json(&escrow, "get_job", json!({ "job_id": no_accept_id })).await?;
    assert_eq!(no_accept_job["state"], "refundable");
    assert_eq!(no_accept_job["claimableBuyer"], WRT_AMOUNT);
    assert_eq!(no_accept_job["claimableProvider"], "0");
    buyer
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": no_accept_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // 2. Provider accepts but does not submit before delivery deadline: the
    // buyer becomes refundable because no artifact was submitted.
    let now_after_accept = worker.view_block().await?.timestamp();
    let accept_by_2 = now_after_accept + 120_000_000_000;
    let deliver_by_2 = now_after_accept + 240_000_000_000;
    let review_by_2 = now_after_accept + 360_000_000_000;
    let no_delivery_terms = terms_with_deadlines(
        "job-deadline-no-delivery",
        &buyer,
        &provider,
        &resolver,
        &ft,
        0,
        accept_by_2,
        deliver_by_2,
        review_by_2,
    );
    let no_delivery_id = create_and_fund(&escrow, &ft, &buyer, no_delivery_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": no_delivery_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    advance_past(&worker, deliver_by_2).await?;
    stranger
        .call(escrow.id(), "make_pre_submission_refund_claimable")
        .args_json(json!({ "job_id": no_delivery_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let no_delivery_job =
        view_json(&escrow, "get_job", json!({ "job_id": no_delivery_id })).await?;
    assert_eq!(no_delivery_job["state"], "refundable");
    buyer
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": no_delivery_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // 3. Buyer silence after provider submission must not auto-refund or
    // auto-pay. After review expiry the job becomes disputed and awaits the
    // exact resolver named in immutable terms.
    let now_after_delivery = worker.view_block().await?.timestamp();
    let accept_by_3 = now_after_delivery + 120_000_000_000;
    let deliver_by_3 = now_after_delivery + 240_000_000_000;
    let review_by_3 = now_after_delivery + 360_000_000_000;
    let submitted_terms = terms_with_deadlines(
        "job-deadline-review-expired",
        &buyer,
        &provider,
        &resolver,
        &ft,
        0,
        accept_by_3,
        deliver_by_3,
        review_by_3,
    );
    let submitted_id = create_and_fund(&escrow, &ft, &buyer, submitted_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": submitted_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": submitted_id, "artifact_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let premature_pre_submission_refund = stranger
        .call(escrow.id(), "make_pre_submission_refund_claimable")
        .args_json(json!({ "job_id": submitted_id }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        premature_pre_submission_refund,
        "submitted work must never enter the pre-submission refund route",
    )?;
    advance_past(&worker, review_by_3).await?;
    stranger
        .call(escrow.id(), "mark_review_expired_disputed")
        .args_json(json!({ "job_id": submitted_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let disputed_job = view_json(&escrow, "get_job", json!({ "job_id": submitted_id })).await?;
    assert_eq!(disputed_job["state"], "disputed");
    assert_eq!(disputed_job["claimableBuyer"], "0");
    assert_eq!(disputed_job["claimableProvider"], "0");
    resolver.call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": submitted_id, "provider_amount": "100000000", "buyer_refund_amount": "0", "rationale_hash": HASH_B }))
        .max_gas().transact().await?.into_result().map(|_| ()).map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": submitted_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(liabilities["totalLiability"], "0");
    assert_eq!(liabilities["accountingInvariantHolds"], true);
    Ok(())
}

#[tokio::test]
async fn sandbox_only_contract_account_can_initialize_escrow_and_test_token() -> Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let buyer = worker.dev_create_account().await?;
    let ft_wasm = wasm_from_env("WORKRELAY_TEST_TOKEN_WASM")?;
    let ft = worker.dev_deploy(&ft_wasm).await?;

    let outsider_token_init = buyer
        .call(ft.id(), "new")
        .args_json(json!({ "owner_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        outsider_token_init,
        "an arbitrary account must not be able to initialize the FT",
    )?;
    ft.call("new")
        .args_json(json!({ "owner_id": buyer.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let escrow_wasm = wasm_from_env("WORKRELAY_JOB_ESCROW_WASM")?;
    let escrow = worker.dev_deploy(&escrow_wasm).await?;
    let outsider_escrow_init = buyer
        .call(escrow.id(), "new")
        .args_json(json!({ "allowed_ft_contract_id": ft.id() }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        outsider_escrow_init,
        "an arbitrary account must not be able to initialize escrow",
    )?;
    escrow
        .call("new")
        .args_json(json!({ "allowed_ft_contract_id": ft.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    Ok(())
}

#[tokio::test]
async fn sandbox_revision_deadline_expiry_uses_dispute_path() -> Result<()> {
    let (worker, ft, escrow, buyer, provider, resolver, stranger) = setup().await?;

    // A buyer cannot request a revision after the provider's committed delivery
    // deadline. The submitted work can still be disputed before review expiry.
    let now = worker.view_block().await?.timestamp();
    let accept_by = now + 120_000_000_000;
    let deliver_by = now + 240_000_000_000;
    let review_by = now + 360_000_000_000;
    let late_revision_terms = terms_with_deadlines(
        "job-late-revision-request",
        &buyer,
        &provider,
        &resolver,
        &ft,
        1,
        accept_by,
        deliver_by,
        review_by,
    );
    let late_revision_id = create_and_fund(&escrow, &ft, &buyer, late_revision_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": late_revision_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": late_revision_id, "artifact_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    advance_past(&worker, deliver_by).await?;
    let late_revision = buyer
        .call(escrow.id(), "request_revision")
        .args_json(json!({ "job_id": late_revision_id, "rationale_hash": HASH_B }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        late_revision,
        "a revision cannot be requested after the committed delivery deadline",
    )?;
    buyer
        .call(escrow.id(), "open_dispute")
        .args_json(json!({ "job_id": late_revision_id, "rationale_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    resolver
        .call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": late_revision_id, "provider_amount": "100000000", "buyer_refund_amount": "0", "rationale_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": late_revision_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    // If the buyer requests a revision before delivery expiry but the provider
    // never resubmits, any caller can move the job to dispute after that deadline.
    // The transition creates neither a refund nor a provider payout.
    let now_after_first = worker.view_block().await?.timestamp();
    let accept_by_2 = now_after_first + 120_000_000_000;
    let deliver_by_2 = now_after_first + 240_000_000_000;
    let review_by_2 = now_after_first + 360_000_000_000;
    let expired_revision_terms = terms_with_deadlines(
        "job-revision-not-resubmitted",
        &buyer,
        &provider,
        &resolver,
        &ft,
        1,
        accept_by_2,
        deliver_by_2,
        review_by_2,
    );
    let expired_revision_id = create_and_fund(&escrow, &ft, &buyer, expired_revision_terms).await?;
    provider
        .call(escrow.id(), "accept_job")
        .args_json(json!({ "job_id": expired_revision_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "submit_artifact")
        .args_json(json!({ "job_id": expired_revision_id, "artifact_hash": HASH_A }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "request_revision")
        .args_json(json!({ "job_id": expired_revision_id, "rationale_hash": HASH_B }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    let early_expiry = stranger
        .call(escrow.id(), "mark_revision_expired_disputed")
        .args_json(json!({ "job_id": expired_revision_id }))
        .max_gas()
        .transact()
        .await?;
    expect_failure(
        early_expiry,
        "revision expiry cannot be triggered before the delivery deadline",
    )?;
    advance_past(&worker, deliver_by_2).await?;
    stranger
        .call(escrow.id(), "mark_revision_expired_disputed")
        .args_json(json!({ "job_id": expired_revision_id }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let disputed = view_json(&escrow, "get_job", json!({ "job_id": expired_revision_id })).await?;
    assert_eq!(disputed["state"], "disputed");
    assert_eq!(disputed["claimableBuyer"], "0");
    assert_eq!(disputed["claimableProvider"], "0");
    let before_resolution = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(before_resolution["unsettledEscrow"], WRT_AMOUNT);
    assert_eq!(before_resolution["accountingInvariantHolds"], true);

    resolver
        .call(escrow.id(), "resolve_dispute")
        .args_json(json!({ "job_id": expired_revision_id, "provider_amount": "75000000", "buyer_refund_amount": "25000000", "rationale_hash": HASH_C }))
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    provider
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": expired_revision_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;
    buyer
        .call(escrow.id(), "withdraw_claim")
        .args_json(json!({ "job_id": expired_revision_id }))
        .deposit(one_yocto())
        .max_gas()
        .transact()
        .await?
        .into_result()
        .map(|_| ())
        .map_err(|failure| anyhow::anyhow!("NEAR transaction execution failed: {failure:?}"))?;

    let final_liabilities = view_json(&escrow, "get_liabilities", json!({})).await?;
    assert_eq!(final_liabilities["totalLiability"], "0");
    assert_eq!(final_liabilities["accountingInvariantHolds"], true);
    Ok(())
}
