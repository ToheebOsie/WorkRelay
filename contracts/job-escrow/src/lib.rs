//! WorkRelay's narrow NEAR testnet escrow proof.
//!
//! This contract does not call Agent Market, does not verify research truth, and
//! cannot be configured on mainnet. It stores hashes and state only.

use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::collections::{LookupMap, UnorderedMap};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::BorshStorageKey;
use near_sdk::{
    assert_one_yocto, env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};
use serde_json::{json, Value};

const TERMS_SCHEMA: &str = "workrelay.testnet-escrow-terms.v1";
const DEPOSIT_MESSAGE_SCHEMA: &str = "workrelay.escrow-deposit.v1";
const EVENT_STANDARD: &str = "workrelay_escrow";
const EVENT_VERSION: &str = "1.0.0";
const WRT_TOKEN_DECIMALS: u8 = 6;
const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const FT_TRANSFER_GAS: Gas = Gas::from_tgas(20);
const WITHDRAW_CALLBACK_GAS: Gas = Gas::from_tgas(25);
const NATIVE_REFUND_CALLBACK_GAS: Gas = Gas::from_tgas(25);

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Jobs,
    UsedJobIds,
    NativeRefunds,
}

/// The exact JSON field order is part of the cross-language commitment format.
/// Do not reorder fields without changing TERMS_SCHEMA and its golden vectors.
#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EscrowTerms {
    pub schema: String,
    pub job_id: String,
    pub buyer_account_id: AccountId,
    pub provider_account_id: AccountId,
    #[serde(default)]
    pub agent_market_handle: Option<String>,
    pub brief_hash: String,
    pub acceptance_criteria_hash: String,
    pub verifier_name: String,
    pub verifier_version: String,
    pub ft_contract_id: AccountId,
    pub token_decimals: u8,
    /// Positive base-10 integer string in the token's atomic units.
    pub atomic_amount: String,
    /// Nanosecond timestamps are strings to avoid JavaScript's 2^53 precision limit.
    pub provider_acceptance_deadline_ns: String,
    pub delivery_deadline_ns: String,
    pub buyer_review_deadline_ns: String,
    pub revision_limit: u8,
    pub resolver_account_id: AccountId,
    pub dispute_policy_version: String,
}

#[derive(BorshDeserialize, BorshSerialize, Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum JobState {
    Created,
    Funded,
    ProviderAccepted,
    Submitted,
    RevisionRequested,
    Accepted,
    Refundable,
    Disputed,
    Resolved,
}

impl JobState {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Funded => "funded",
            Self::ProviderAccepted => "provider_accepted",
            Self::Submitted => "submitted",
            Self::RevisionRequested => "revision_requested",
            Self::Accepted => "accepted",
            Self::Refundable => "refundable",
            Self::Disputed => "disputed",
            Self::Resolved => "resolved",
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Accepted | Self::Refundable | Self::Resolved)
    }
}

#[derive(BorshDeserialize, BorshSerialize, Clone)]
struct Job {
    terms: EscrowTerms,
    terms_hash: String,
    state: JobState,
    created_at_ns: u64,
    has_artifact: bool,
    artifact_hash: String,
    rationale_hash: String,
    revision_count: u8,
    /// Storage deposit retained for this exact map entry until archival.
    storage_stake_yocto: u128,
    storage_byte_cost_yocto: u128,
    claimable_buyer: u128,
    claimable_provider: u128,
    in_flight_active: bool,
    /// Preallocated to max(buyer, provider) AccountId length during create_job.
    in_flight_account: String,
    in_flight_amount: u128,
    in_flight_attempt_id: u64,
    in_flight_is_provider: bool,
    withdrawal_nonce: u64,
}

/// Native NEAR refunds are pull claims. A failed transfer is restored by a
/// private callback, just like an FT withdrawal. Keeping this record separate
/// from WRT liabilities prevents mixing two different asset-accounting systems.
#[derive(BorshDeserialize, BorshSerialize, Clone, Default)]
struct NativeRefund {
    claimable: u128,
    in_flight: u128,
    next_attempt_id: u64,
    in_flight_attempt_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub terms: EscrowTerms,
    pub terms_hash: String,
    pub state: String,
    pub created_at_ns: String,
    pub artifact_hash: Option<String>,
    pub rationale_hash: Option<String>,
    pub revision_count: u8,
    pub storage_stake_yocto: U128,
    pub storage_byte_cost_yocto: U128,
    pub claimable_buyer: U128,
    pub claimable_provider: U128,
    pub in_flight_active: bool,
    pub in_flight_account: Option<String>,
    pub in_flight_amount: U128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    pub account_id: AccountId,
    pub claimable: U128,
    pub in_flight: U128,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeRefundView {
    pub account_id: AccountId,
    pub claimable: U128,
    pub in_flight: U128,
    pub next_attempt_id: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiabilitiesView {
    pub total_liability: U128,
    pub unsettled_escrow: U128,
    pub claimable: U128,
    pub in_flight: U128,
    pub native_refund_liability: U128,
    /// This invariant covers WRT escrow liabilities only; native NEAR refunds
    /// are reported separately and are never combined with WRT atomic units.
    pub accounting_invariant_holds: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractConfigView {
    pub contract_account_id: AccountId,
    pub chain_id: String,
    pub allowed_ft_contract_id: AccountId,
    pub terms_schema: String,
    pub deposit_message_schema: String,
    pub token_decimals: u8,
    pub mainnet_enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DepositMessage {
    schema: String,
    job_id: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct JobEscrow {
    allowed_ft_contract_id: AccountId,
    jobs: UnorderedMap<String, Job>,
    /// Permanent tombstones prevent a job ID from being reused after archival.
    used_job_ids: LookupMap<String, bool>,
    native_refunds: LookupMap<AccountId, NativeRefund>,
    total_liability: u128,
    unsettled_escrow: u128,
    native_refund_liability: u128,
}

// This trait is consumed by #[ext_contract] to generate the remote FT client.
#[allow(dead_code)]
#[ext_contract(ext_ft)]
trait ExtFungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

// This trait is consumed by #[ext_contract] to generate private callback clients.
#[allow(dead_code)]
#[ext_contract(ext_self)]
trait ExtJobEscrow {
    fn resolve_withdrawal(
        &mut self,
        job_id: String,
        account_id: AccountId,
        amount: U128,
        attempt_id: u64,
        is_provider: bool,
    ) -> bool;
    fn resolve_native_refund(
        &mut self,
        account_id: AccountId,
        amount: U128,
        attempt_id: u64,
    ) -> bool;
}

#[near]
impl JobEscrow {
    #[init]
    pub fn new(allowed_ft_contract_id: AccountId) -> Self {
        assert_supported_chain();
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the escrow account itself may initialize the contract"
        );
        assert!(
            allowed_ft_contract_id != env::current_account_id(),
            "The allowlisted FT must be a separate contract"
        );
        Self {
            allowed_ft_contract_id,
            jobs: UnorderedMap::new(StorageKey::Jobs),
            used_job_ids: LookupMap::new(StorageKey::UsedJobIds),
            native_refunds: LookupMap::new(StorageKey::NativeRefunds),
            total_liability: 0,
            unsettled_escrow: 0,
            native_refund_liability: 0,
        }
    }

    /// Preview the exact digest that create_job will persist.
    pub fn preview_terms_hash(&self, terms: EscrowTerms) -> String {
        validate_terms(&terms, &self.allowed_ft_contract_id, env::block_timestamp());
        terms_hash(&terms)
    }

    /// Create the immutable, hash-bound job agreement. Attached NEAR covers
    /// the actual storage growth; any excess is returned to the buyer.
    #[payable]
    pub fn create_job(&mut self, terms: EscrowTerms) -> String {
        assert_supported_chain();
        validate_terms(&terms, &self.allowed_ft_contract_id, env::block_timestamp());
        let caller = env::predecessor_account_id();
        assert_eq!(
            caller, terms.buyer_account_id,
            "Only the named buyer may create the job"
        );
        assert!(
            !self.used_job_ids.contains_key(&terms.job_id),
            "Job ID has already been used and cannot be reused"
        );

        let terms_hash = terms_hash(&terms);
        let max_account_len = terms
            .buyer_account_id
            .as_str()
            .len()
            .max(terms.provider_account_id.as_str().len());
        let job = Job {
            terms: terms.clone(),
            terms_hash: terms_hash.clone(),
            state: JobState::Created,
            created_at_ns: env::block_timestamp(),
            has_artifact: false,
            artifact_hash: ZERO_HASH.to_string(),
            rationale_hash: ZERO_HASH.to_string(),
            revision_count: 0,
            storage_stake_yocto: 0,
            storage_byte_cost_yocto: env::storage_byte_cost().as_yoctonear(),
            claimable_buyer: 0,
            claimable_provider: 0,
            in_flight_active: false,
            in_flight_account: "x".repeat(max_account_len),
            in_flight_amount: 0,
            in_flight_attempt_id: 0,
            in_flight_is_provider: false,
            withdrawal_nonce: 0,
        };

        let storage_before = env::storage_usage();
        self.used_job_ids.insert(&terms.job_id, &true);
        self.jobs.insert(&terms.job_id, &job);
        // Pre-create a fixed-size refund record before measuring storage. This
        // makes its storage cost part of the buyer's measured storage deposit.
        if self.native_refunds.get(&caller).is_none() {
            self.native_refunds
                .insert(&caller, &NativeRefund::default());
        }
        let storage_after = env::storage_usage();
        let bytes_added = storage_after
            .checked_sub(storage_before)
            .expect("Storage usage must not decrease while creating a job");
        let required_stake = (bytes_added as u128)
            .checked_mul(job.storage_byte_cost_yocto)
            .expect("Storage stake overflow");
        let attached = env::attached_deposit().as_yoctonear();
        assert!(required_stake > 0, "Storage stake must be non-zero");
        assert!(
            attached >= required_stake,
            "Insufficient NEAR storage deposit"
        );

        let mut stored = self.jobs.get(&terms.job_id).expect("Just inserted");
        stored.storage_stake_yocto = required_stake;
        self.jobs.insert(&terms.job_id, &stored);

        let excess = attached - required_stake;
        if excess > 0 {
            self.credit_native_refund(&caller, excess);
        }
        emit_event(
            "job_created",
            json!([{ "jobId": terms.job_id, "buyer": caller, "termsHash": terms_hash, "storageStakeYocto": required_stake.to_string() }]),
        );
        terms_hash
    }

    pub fn accept_job(&mut self, job_id: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.provider_account_id,
            "Only assigned provider"
        );
        assert_eq!(
            job.state,
            JobState::Funded,
            "Job must be funded and awaiting provider acceptance"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.provider_acceptance_deadline_ns),
            "Provider acceptance deadline passed"
        );
        job.state = JobState::ProviderAccepted;
        self.jobs.insert(&job_id, &job);
        emit_event("provider_accepted", json!([{ "jobId": job_id }]));
    }

    pub fn decline_job(&mut self, job_id: String, rationale_hash: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.provider_account_id,
            "Only assigned provider"
        );
        assert_eq!(
            job.state,
            JobState::Funded,
            "Only a funded, unaccepted job can be declined"
        );
        validate_hash(&rationale_hash, "Invalid decline rationale hash");
        job.rationale_hash = rationale_hash.clone();
        job.state = JobState::Refundable;
        self.move_unsettled_to_buyer_claim(&mut job);
        self.jobs.insert(&job_id, &job);
        emit_event(
            "provider_declined",
            json!([{ "jobId": job_id, "rationaleHash": rationale_hash }]),
        );
        emit_event(
            "refund_claimable",
            json!([{ "jobId": job_id, "amount": job.claimable_buyer.to_string() }]),
        );
    }

    pub fn submit_artifact(&mut self, job_id: String, artifact_hash: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.provider_account_id,
            "Only assigned provider"
        );
        assert!(
            matches!(
                job.state,
                JobState::ProviderAccepted | JobState::RevisionRequested
            ),
            "Job is not accepting a provider submission"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.delivery_deadline_ns),
            "Delivery deadline passed"
        );
        validate_hash(&artifact_hash, "Invalid artifact hash");
        if job.has_artifact {
            assert_ne!(
                artifact_hash, job.artifact_hash,
                "A resubmission must have a new artifact hash"
            );
        }
        job.has_artifact = true;
        job.artifact_hash = artifact_hash.clone();
        job.state = JobState::Submitted;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "artifact_submitted",
            json!([{ "jobId": job_id, "artifactHash": artifact_hash, "revisionCount": job.revision_count }]),
        );
    }

    pub fn request_revision(&mut self, job_id: String, rationale_hash: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.buyer_account_id,
            "Only buyer"
        );
        assert_eq!(
            job.state,
            JobState::Submitted,
            "A submitted artifact is required"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.buyer_review_deadline_ns),
            "Buyer review deadline passed"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.delivery_deadline_ns),
            "Delivery deadline passed; a revision can no longer be requested"
        );
        assert!(
            job.revision_count < job.terms.revision_limit,
            "Committed revision limit exhausted"
        );
        validate_hash(&rationale_hash, "Invalid revision rationale hash");
        job.revision_count = job
            .revision_count
            .checked_add(1)
            .expect("Revision count overflow");
        job.rationale_hash = rationale_hash.clone();
        job.state = JobState::RevisionRequested;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "revision_requested",
            json!([{ "jobId": job_id, "revisionCount": job.revision_count, "rationaleHash": rationale_hash }]),
        );
    }

    pub fn accept_delivery(&mut self, job_id: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.buyer_account_id,
            "Only buyer"
        );
        assert_eq!(
            job.state,
            JobState::Submitted,
            "A submitted artifact is required"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.buyer_review_deadline_ns),
            "Buyer review deadline passed; use dispute route"
        );
        job.state = JobState::Accepted;
        self.move_unsettled_to_provider_claim(&mut job);
        self.jobs.insert(&job_id, &job);
        emit_event(
            "delivery_accepted",
            json!([{ "jobId": job_id, "artifactHash": job.artifact_hash, "providerClaim": job.claimable_provider.to_string() }]),
        );
    }

    pub fn open_dispute(&mut self, job_id: String, rationale_hash: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.buyer_account_id,
            "Only buyer"
        );
        assert_eq!(
            job.state,
            JobState::Submitted,
            "A submitted artifact is required"
        );
        assert!(
            env::block_timestamp() <= parse_u64(&job.terms.buyer_review_deadline_ns),
            "Review deadline passed; dispute is already required"
        );
        validate_hash(&rationale_hash, "Invalid dispute rationale hash");
        job.rationale_hash = rationale_hash.clone();
        job.state = JobState::Disputed;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "dispute_opened",
            json!([{ "jobId": job_id, "resolver": job.terms.resolver_account_id, "rationaleHash": rationale_hash }]),
        );
    }

    /// Permissionless transition after buyer review expires. It deliberately
    /// creates no payout/refund claim; the named resolver must allocate funds.
    pub fn mark_review_expired_disputed(&mut self, job_id: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            job.state,
            JobState::Submitted,
            "Only a submitted, unresolved job can expire into dispute"
        );
        assert!(
            env::block_timestamp() > parse_u64(&job.terms.buyer_review_deadline_ns),
            "Buyer review deadline has not passed"
        );
        job.rationale_hash = ZERO_HASH.to_string();
        job.state = JobState::Disputed;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "review_expired_disputed",
            json!([{ "jobId": job_id, "resolver": job.terms.resolver_account_id }]),
        );
    }

    /// A requested revision that is not resubmitted by the committed delivery
    /// deadline enters dispute. No automatic refund or payout is created; the
    /// named resolver must allocate the escrow, preserving the post-submission
    /// dispute policy.
    pub fn mark_revision_expired_disputed(&mut self, job_id: String) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            job.state,
            JobState::RevisionRequested,
            "Only a job awaiting a revision can expire into dispute"
        );
        assert!(
            env::block_timestamp() > parse_u64(&job.terms.delivery_deadline_ns),
            "Revision delivery deadline has not passed"
        );
        job.rationale_hash = ZERO_HASH.to_string();
        job.state = JobState::Disputed;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "revision_expired_disputed",
            json!([{ "jobId": job_id, "resolver": job.terms.resolver_account_id }]),
        );
    }

    /// Permissionless deadline trigger for pre-submission refunds. The buyer
    /// alone owns the resulting claim; the transition never transfers tokens.
    pub fn make_pre_submission_refund_claimable(&mut self, job_id: String) {
        let mut job = self.job_or_panic(&job_id);
        let now = env::block_timestamp();
        let eligible = match job.state {
            JobState::Funded => now > parse_u64(&job.terms.provider_acceptance_deadline_ns),
            JobState::ProviderAccepted => now > parse_u64(&job.terms.delivery_deadline_ns),
            _ => false,
        };
        assert!(eligible, "No eligible pre-submission refund condition");
        job.state = JobState::Refundable;
        self.move_unsettled_to_buyer_claim(&mut job);
        self.jobs.insert(&job_id, &job);
        emit_event(
            "refund_claimable",
            json!([{ "jobId": job_id, "amount": job.claimable_buyer.to_string() }]),
        );
    }

    pub fn resolve_dispute(
        &mut self,
        job_id: String,
        provider_amount: U128,
        buyer_refund_amount: U128,
        rationale_hash: String,
    ) {
        let mut job = self.job_or_panic(&job_id);
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.resolver_account_id,
            "Only named resolver"
        );
        assert_eq!(job.state, JobState::Disputed, "Job is not disputed");
        validate_hash(&rationale_hash, "Invalid resolution rationale hash");
        let amount = parse_amount(&job.terms.atomic_amount);
        let allocated = provider_amount
            .0
            .checked_add(buyer_refund_amount.0)
            .expect("Allocation overflow");
        assert_eq!(
            allocated, amount,
            "Resolution must allocate the exact escrow amount"
        );
        job.claimable_provider = provider_amount.0;
        job.claimable_buyer = buyer_refund_amount.0;
        job.rationale_hash = rationale_hash.clone();
        job.state = JobState::Resolved;
        self.unsettled_escrow = self
            .unsettled_escrow
            .checked_sub(amount)
            .expect("Unsettled liability underflow");
        self.jobs.insert(&job_id, &job);
        emit_event(
            "dispute_resolved",
            json!([{ "jobId": job_id, "providerAmount": provider_amount.0.to_string(), "buyerRefundAmount": buyer_refund_amount.0.to_string(), "rationaleHash": rationale_hash }]),
        );
    }

    /// Starts a pull withdrawal. One transfer may be in flight per job; the
    /// liability is retained until the private callback confirms token success.
    #[payable]
    pub fn withdraw_claim(&mut self, job_id: String) -> Promise {
        assert_one_yocto();
        let caller = env::predecessor_account_id();
        let mut job = self.job_or_panic(&job_id);
        assert!(
            !job.in_flight_active,
            "A withdrawal is already in flight for this job"
        );
        let is_provider = if caller == job.terms.provider_account_id {
            true
        } else if caller == job.terms.buyer_account_id {
            false
        } else {
            env::panic_str("Only a buyer or assigned provider can withdraw this job's claim")
        };
        let amount = if is_provider {
            job.claimable_provider
        } else {
            job.claimable_buyer
        };
        assert!(amount > 0, "No claimable balance for caller");
        if is_provider {
            job.claimable_provider = 0;
        } else {
            job.claimable_buyer = 0;
        }
        job.withdrawal_nonce = job
            .withdrawal_nonce
            .checked_add(1)
            .expect("Withdrawal nonce overflow");
        let attempt_id = job.withdrawal_nonce;
        job.in_flight_active = true;
        job.in_flight_account = caller.to_string();
        job.in_flight_amount = amount;
        job.in_flight_attempt_id = attempt_id;
        job.in_flight_is_provider = is_provider;
        self.jobs.insert(&job_id, &job);
        emit_event(
            "withdrawal_started",
            json!([{ "jobId": job_id, "accountId": caller, "amount": amount.to_string(), "attemptId": attempt_id }]),
        );

        ext_ft::ext(self.allowed_ft_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(FT_TRANSFER_GAS)
            .ft_transfer(
                caller.clone(),
                U128(amount),
                Some(format!("WorkRelay escrow withdrawal {job_id}")),
            )
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(WITHDRAW_CALLBACK_GAS)
                    .resolve_withdrawal(job_id, caller, U128(amount), attempt_id, is_provider),
            )
    }

    #[private]
    pub fn resolve_withdrawal(
        &mut self,
        job_id: String,
        account_id: AccountId,
        amount: U128,
        attempt_id: u64,
        is_provider: bool,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let mut job = self.job_or_panic(&job_id);
        assert!(job.in_flight_active, "No withdrawal is in flight");
        assert_eq!(
            job.in_flight_attempt_id, attempt_id,
            "Stale or replayed withdrawal callback"
        );
        assert_eq!(
            job.in_flight_account,
            account_id.as_str(),
            "Withdrawal account mismatch"
        );
        assert_eq!(job.in_flight_amount, amount.0, "Withdrawal amount mismatch");
        assert_eq!(
            job.in_flight_is_provider, is_provider,
            "Withdrawal role mismatch"
        );

        let succeeded = result.is_ok();
        if succeeded {
            self.total_liability = self
                .total_liability
                .checked_sub(amount.0)
                .expect("Total liability underflow");
        } else if is_provider {
            job.claimable_provider = job
                .claimable_provider
                .checked_add(amount.0)
                .expect("Provider claim overflow");
        } else {
            job.claimable_buyer = job
                .claimable_buyer
                .checked_add(amount.0)
                .expect("Buyer claim overflow");
        }

        job.in_flight_active = false;
        job.in_flight_account = "x".repeat(
            job.terms
                .buyer_account_id
                .as_str()
                .len()
                .max(job.terms.provider_account_id.as_str().len()),
        );
        job.in_flight_amount = 0;
        job.in_flight_attempt_id = 0;
        job.in_flight_is_provider = false;
        self.jobs.insert(&job_id, &job);
        emit_event(
            if succeeded {
                "withdrawal_succeeded"
            } else {
                "withdrawal_failed_restored"
            },
            json!([{ "jobId": job_id, "accountId": account_id, "amount": amount.0.to_string(), "attemptId": attempt_id }]),
        );
        succeeded
    }

    /// Withdraw accumulated storage-deposit and archive refunds in native NEAR.
    /// The claim remains a liability until the private callback confirms success.
    #[payable]
    pub fn withdraw_storage_refund(&mut self) -> Promise {
        assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let mut refund = self.native_refunds.get(&account_id).unwrap_or_default();
        assert_eq!(
            refund.in_flight, 0,
            "A native refund withdrawal is already in flight"
        );
        let amount = refund.claimable;
        assert!(amount > 0, "No native NEAR refund is claimable");

        refund.claimable = 0;
        refund.in_flight = amount;
        refund.next_attempt_id = refund
            .next_attempt_id
            .checked_add(1)
            .expect("Refund attempt ID overflow");
        let attempt_id = refund.next_attempt_id;
        refund.in_flight_attempt_id = attempt_id;
        self.native_refunds.insert(&account_id, &refund);
        emit_event(
            "native_refund_withdrawal_started",
            json!([{ "accountId": account_id, "amountYocto": amount.to_string(), "attemptId": attempt_id }]),
        );

        Promise::new(account_id.clone())
            .transfer(NearToken::from_yoctonear(amount))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(NATIVE_REFUND_CALLBACK_GAS)
                    .resolve_native_refund(account_id, U128(amount), attempt_id),
            )
    }

    #[private]
    pub fn resolve_native_refund(
        &mut self,
        account_id: AccountId,
        amount: U128,
        attempt_id: u64,
        #[callback_result] result: Result<(), PromiseError>,
    ) -> bool {
        let mut refund = self
            .native_refunds
            .get(&account_id)
            .unwrap_or_else(|| env::panic_str("Native refund record missing"));
        assert_eq!(refund.in_flight, amount.0, "Native refund amount mismatch");
        assert_eq!(
            refund.in_flight_attempt_id, attempt_id,
            "Stale or replayed native refund callback"
        );

        let succeeded = result.is_ok();
        if succeeded {
            self.native_refund_liability = self
                .native_refund_liability
                .checked_sub(amount.0)
                .expect("Native refund liability underflow");
        } else {
            refund.claimable = refund
                .claimable
                .checked_add(amount.0)
                .expect("Native refund restoration overflow");
        }
        refund.in_flight = 0;
        refund.in_flight_attempt_id = 0;
        self.native_refunds.insert(&account_id, &refund);
        emit_event(
            if succeeded {
                "native_refund_withdrawal_succeeded"
            } else {
                "native_refund_withdrawal_restored"
            },
            json!([{ "accountId": account_id, "amountYocto": amount.0.to_string(), "attemptId": attempt_id }]),
        );
        succeeded
    }

    /// Archive only after the terminal allocation has been fully withdrawn.
    /// The job record's actually released storage is credited to the buyer's
    /// pull-refund balance; no native transfer is detached from this method.
    /// A compact permanent job-ID tombstone remains to prevent replay/reuse.
    pub fn archive_terminal_job(&mut self, job_id: String) {
        let job = self.job_or_panic(&job_id);
        assert!(
            job.state.is_terminal(),
            "Only terminal jobs can be archived"
        );
        assert_eq!(
            env::predecessor_account_id(),
            job.terms.buyer_account_id,
            "Only buyer may archive"
        );
        assert_eq!(job.claimable_buyer, 0, "Buyer claim remains outstanding");
        assert_eq!(
            job.claimable_provider, 0,
            "Provider claim remains outstanding"
        );
        assert!(!job.in_flight_active, "Withdrawal remains in flight");
        let buyer = job.terms.buyer_account_id.clone();
        let storage_before = env::storage_usage();
        self.jobs.remove(&job_id);
        let storage_after = env::storage_usage();
        let bytes_released = storage_before
            .checked_sub(storage_after)
            .expect("Archiving a job must not increase storage usage");
        let storage_refund = (bytes_released as u128)
            .checked_mul(job.storage_byte_cost_yocto)
            .expect("Storage refund overflow");
        assert!(
            storage_refund <= job.storage_stake_yocto,
            "Storage refund cannot exceed the buyer's original storage stake"
        );
        if storage_refund > 0 {
            self.credit_native_refund(&buyer, storage_refund);
        }
        emit_event(
            "job_archived",
            json!([{ "jobId": job_id, "buyer": buyer, "storageRefundYocto": storage_refund.to_string(), "jobIdTombstoneRetained": true }]),
        );
    }

    pub fn get_job(&self, job_id: String) -> Option<JobView> {
        self.jobs.get(&job_id).map(job_to_view)
    }

    pub fn is_job_id_used(&self, job_id: String) -> bool {
        self.used_job_ids.contains_key(&job_id)
    }

    pub fn get_contract_config(&self) -> ContractConfigView {
        ContractConfigView {
            contract_account_id: env::current_account_id(),
            chain_id: env::chain_id(),
            allowed_ft_contract_id: self.allowed_ft_contract_id.clone(),
            terms_schema: TERMS_SCHEMA.to_string(),
            deposit_message_schema: DEPOSIT_MESSAGE_SCHEMA.to_string(),
            token_decimals: WRT_TOKEN_DECIMALS,
            mainnet_enabled: false,
        }
    }

    pub fn get_claim(&self, job_id: String, account_id: AccountId) -> Option<ClaimView> {
        self.jobs.get(&job_id).map(|job| {
            let claimable = if account_id == job.terms.buyer_account_id {
                job.claimable_buyer
            } else if account_id == job.terms.provider_account_id {
                job.claimable_provider
            } else {
                0
            };
            let in_flight = if job.in_flight_active && job.in_flight_account == account_id.as_str()
            {
                job.in_flight_amount
            } else {
                0
            };
            ClaimView {
                account_id,
                claimable: U128(claimable),
                in_flight: U128(in_flight),
            }
        })
    }

    pub fn get_native_refund(&self, account_id: AccountId) -> Option<NativeRefundView> {
        self.native_refunds
            .get(&account_id)
            .map(|refund| NativeRefundView {
                account_id,
                claimable: U128(refund.claimable),
                in_flight: U128(refund.in_flight),
                next_attempt_id: refund.next_attempt_id,
            })
    }

    pub fn get_liabilities(&self) -> LiabilitiesView {
        let mut claimable = 0u128;
        let mut in_flight = 0u128;
        for (_, job) in self.jobs.iter() {
            claimable = claimable
                .checked_add(job.claimable_buyer)
                .and_then(|v| v.checked_add(job.claimable_provider))
                .expect("Claimable total overflow");
            if job.in_flight_active {
                in_flight = in_flight
                    .checked_add(job.in_flight_amount)
                    .expect("In-flight total overflow");
            }
        }
        let accounted = self
            .unsettled_escrow
            .checked_add(claimable)
            .and_then(|v| v.checked_add(in_flight))
            .expect("Liability sum overflow");
        LiabilitiesView {
            total_liability: U128(self.total_liability),
            unsettled_escrow: U128(self.unsettled_escrow),
            claimable: U128(claimable),
            in_flight: U128(in_flight),
            native_refund_liability: U128(self.native_refund_liability),
            accounting_invariant_holds: accounted == self.total_liability,
        }
    }

    fn credit_native_refund(&mut self, account_id: &AccountId, amount: u128) {
        if amount == 0 {
            return;
        }
        let mut refund = self.native_refunds.get(account_id).unwrap_or_default();
        refund.claimable = refund
            .claimable
            .checked_add(amount)
            .expect("Native refund credit overflow");
        self.native_refund_liability = self
            .native_refund_liability
            .checked_add(amount)
            .expect("Native refund liability overflow");
        self.native_refunds.insert(account_id, &refund);
    }

    fn job_or_panic(&self, job_id: &str) -> Job {
        self.jobs
            .get(&job_id.to_string())
            .unwrap_or_else(|| env::panic_str("Unknown job ID"))
    }

    fn move_unsettled_to_buyer_claim(&mut self, job: &mut Job) {
        let amount = parse_amount(&job.terms.atomic_amount);
        assert_eq!(job.claimable_buyer, 0, "Buyer claim already allocated");
        self.unsettled_escrow = self
            .unsettled_escrow
            .checked_sub(amount)
            .expect("Unsettled liability underflow");
        job.claimable_buyer = amount;
    }

    fn move_unsettled_to_provider_claim(&mut self, job: &mut Job) {
        let amount = parse_amount(&job.terms.atomic_amount);
        assert_eq!(
            job.claimable_provider, 0,
            "Provider claim already allocated"
        );
        self.unsettled_escrow = self
            .unsettled_escrow
            .checked_sub(amount)
            .expect("Unsettled liability underflow");
        job.claimable_provider = amount;
    }
}

#[near]
impl FungibleTokenReceiver for JobEscrow {
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let predecessor = env::predecessor_account_id();
        if predecessor != self.allowed_ft_contract_id {
            env::log_str("Rejected escrow deposit: unallowlisted FT contract");
            return PromiseOrValue::Value(amount);
        }
        let message: DepositMessage = match serde_json::from_str(&msg) {
            Ok(value) => value,
            Err(_) => {
                env::log_str("Rejected escrow deposit: malformed message");
                return PromiseOrValue::Value(amount);
            }
        };
        if message.schema != DEPOSIT_MESSAGE_SCHEMA {
            env::log_str("Rejected escrow deposit: unsupported message schema");
            return PromiseOrValue::Value(amount);
        }
        let maybe_job = self.jobs.get(&message.job_id);
        let Some(mut job) = maybe_job else {
            env::log_str("Rejected escrow deposit: unknown job");
            return PromiseOrValue::Value(amount);
        };
        if job.state != JobState::Created
            || sender_id != job.terms.buyer_account_id
            || amount.0 != parse_amount(&job.terms.atomic_amount)
            || predecessor != job.terms.ft_contract_id
        {
            env::log_str("Rejected escrow deposit: state, sender, token or amount mismatch");
            return PromiseOrValue::Value(amount);
        }
        job.state = JobState::Funded;
        self.unsettled_escrow = self
            .unsettled_escrow
            .checked_add(amount.0)
            .expect("Unsettled escrow overflow");
        self.total_liability = self
            .total_liability
            .checked_add(amount.0)
            .expect("Total liability overflow");
        self.jobs.insert(&message.job_id, &job);
        emit_event(
            "job_funded",
            json!([{ "jobId": message.job_id, "buyer": sender_id, "amount": amount.0.to_string(), "ftContractId": predecessor }]),
        );
        PromiseOrValue::Value(U128(0))
    }
}

fn job_to_view(job: Job) -> JobView {
    JobView {
        terms: job.terms,
        terms_hash: job.terms_hash,
        state: job.state.as_str().to_string(),
        created_at_ns: job.created_at_ns.to_string(),
        artifact_hash: if job.has_artifact {
            Some(job.artifact_hash)
        } else {
            None
        },
        rationale_hash: if job.rationale_hash != ZERO_HASH {
            Some(job.rationale_hash)
        } else {
            None
        },
        revision_count: job.revision_count,
        storage_stake_yocto: U128(job.storage_stake_yocto),
        storage_byte_cost_yocto: U128(job.storage_byte_cost_yocto),
        claimable_buyer: U128(job.claimable_buyer),
        claimable_provider: U128(job.claimable_provider),
        in_flight_active: job.in_flight_active,
        in_flight_account: if job.in_flight_active {
            Some(job.in_flight_account)
        } else {
            None
        },
        in_flight_amount: U128(job.in_flight_amount),
    }
}

fn assert_supported_chain() {
    let chain_id = env::chain_id();
    assert!(
        chain_id == "testnet" || chain_id == "sandbox",
        "WorkRelay escrow is testnet/sandbox only; mainnet is disabled"
    );
}

fn validate_terms(terms: &EscrowTerms, allowed_ft: &AccountId, now_ns: u64) {
    assert_eq!(terms.schema, TERMS_SCHEMA, "Unsupported terms schema");
    assert!(
        !terms.job_id.is_empty() && terms.job_id.len() <= 64,
        "Invalid job ID length"
    );
    assert!(
        terms
            .job_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)),
        "Job ID must be ASCII identifier characters"
    );
    assert_eq!(
        &terms.ft_contract_id, allowed_ft,
        "Terms use a non-allowlisted FT contract"
    );
    assert!(
        terms.buyer_account_id != terms.provider_account_id,
        "Buyer and provider must differ"
    );
    assert!(
        terms.resolver_account_id != terms.buyer_account_id,
        "Resolver must differ from buyer"
    );
    assert!(
        terms.resolver_account_id != terms.provider_account_id,
        "Resolver must differ from provider"
    );
    assert_eq!(
        terms.token_decimals, WRT_TOKEN_DECIMALS,
        "This escrow version accepts only WRT with 6 decimals"
    );
    let amount = parse_amount(&terms.atomic_amount);
    assert!(amount > 0, "Atomic amount must be positive");
    validate_hash(&terms.brief_hash, "Invalid brief hash");
    validate_hash(
        &terms.acceptance_criteria_hash,
        "Invalid acceptance criteria hash",
    );
    assert!(
        terms.verifier_name.is_ascii()
            && !terms.verifier_name.trim().is_empty()
            && terms.verifier_name.len() <= 80,
        "Invalid verifier name"
    );
    assert!(
        terms.verifier_version.is_ascii()
            && !terms.verifier_version.trim().is_empty()
            && terms.verifier_version.len() <= 40,
        "Invalid verifier version"
    );
    assert!(
        terms.dispute_policy_version.is_ascii()
            && !terms.dispute_policy_version.trim().is_empty()
            && terms.dispute_policy_version.len() <= 64,
        "Invalid dispute policy version"
    );
    if let Some(handle) = &terms.agent_market_handle {
        assert!(
            handle.is_ascii() && handle.len() <= 256,
            "Agent Market handle must be ASCII and at most 256 bytes"
        );
    }
    assert!(
        terms.revision_limit <= 1,
        "Version 1 supports at most one revision"
    );
    let accept_by = parse_u64(&terms.provider_acceptance_deadline_ns);
    let deliver_by = parse_u64(&terms.delivery_deadline_ns);
    let review_by = parse_u64(&terms.buyer_review_deadline_ns);
    assert!(
        accept_by > now_ns,
        "Provider acceptance deadline must be in the future"
    );
    assert!(
        accept_by < deliver_by && deliver_by < review_by,
        "Deadlines must be strictly ordered"
    );
}

fn canonical_amount(value: &str) -> Option<u128> {
    let amount = value.parse::<u128>().ok()?;
    (amount > 0 && amount.to_string() == value).then_some(amount)
}

fn parse_amount(value: &str) -> u128 {
    canonical_amount(value).unwrap_or_else(|| {
        env::panic_str("Atomic amount must be a positive canonical base-10 u128 string")
    })
}

fn canonical_deadline(value: &str) -> Option<u64> {
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value).then_some(parsed)
}

fn parse_u64(value: &str) -> u64 {
    canonical_deadline(value)
        .unwrap_or_else(|| env::panic_str("Deadline must be a canonical base-10 u64 string"))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn validate_hash(value: &str, message: &str) {
    assert!(is_lowercase_sha256(value), "{message}");
}

fn terms_hash(terms: &EscrowTerms) -> String {
    // Serde serializes struct fields in declaration order; this compact JSON
    // byte sequence is the v1 cross-language commitment format.
    let bytes = serde_json::to_vec(terms).expect("Validated terms must serialize");
    hex_encode(&env::sha256(&bytes))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(HEX[(byte >> 4) as usize] as char);
        result.push(HEX[(byte & 0x0f) as usize] as char);
    }
    result
}

fn emit_event(event: &str, data: Value) {
    let event_json = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{event_json}"));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_amount_requires_positive_decimal_without_leading_zeroes() {
        assert_eq!(canonical_amount("17"), Some(17));
        assert_eq!(canonical_amount("0"), None);
        assert_eq!(canonical_amount("00017"), None);
        assert_eq!(canonical_amount("+17"), None);
        assert_eq!(canonical_amount("1.7"), None);
        assert_eq!(canonical_amount(""), None);
    }

    #[test]
    fn canonical_deadline_rejects_leading_zeroes_and_overflow() {
        assert_eq!(canonical_deadline("17"), Some(17));
        assert_eq!(canonical_deadline("0"), Some(0));
        assert_eq!(canonical_deadline("017"), None);
        assert_eq!(canonical_deadline("18446744073709551616"), None);
    }

    #[test]
    fn sha256_validator_accepts_only_lowercase_64_character_hex() {
        assert!(is_lowercase_sha256(ZERO_HASH));
        assert!(is_lowercase_sha256(&"a".repeat(64)));
        assert!(!is_lowercase_sha256(&"A".repeat(64)));
        assert!(!is_lowercase_sha256(&"a".repeat(63)));
        assert!(!is_lowercase_sha256(&format!("{}g", "a".repeat(63))));
    }

    #[test]
    fn failed_native_refund_callback_restores_exact_claim_and_liability() {
        use near_sdk::test_utils::VMContextBuilder;

        let escrow_id: AccountId = "escrow.testnet".parse().unwrap();
        let buyer_id: AccountId = "buyer.testnet".parse().unwrap();
        near_sdk::testing_env!(VMContextBuilder::new()
            .current_account_id(escrow_id.clone())
            .predecessor_account_id(escrow_id.clone())
            .build());

        let mut native_refunds = LookupMap::new(StorageKey::NativeRefunds);
        native_refunds.insert(
            &buyer_id,
            &NativeRefund {
                claimable: 0,
                in_flight: 75,
                next_attempt_id: 3,
                in_flight_attempt_id: 3,
            },
        );
        let mut contract = JobEscrow {
            allowed_ft_contract_id: "wrt.testnet".parse().unwrap(),
            jobs: UnorderedMap::new(StorageKey::Jobs),
            used_job_ids: LookupMap::new(StorageKey::UsedJobIds),
            native_refunds,
            total_liability: 0,
            unsettled_escrow: 0,
            native_refund_liability: 75,
        };

        let succeeded = contract.resolve_native_refund(
            buyer_id.clone(),
            U128(75),
            3,
            Err(PromiseError::Failed),
        );

        assert!(
            !succeeded,
            "a failed native transfer must not be reported as successful"
        );
        let restored = contract.native_refunds.get(&buyer_id).unwrap();
        assert_eq!(
            restored.claimable, 75,
            "the exact failed amount must be restored"
        );
        assert_eq!(
            restored.in_flight, 0,
            "the failed in-flight amount must be cleared"
        );
        assert_eq!(
            restored.in_flight_attempt_id, 0,
            "the completed attempt must be cleared"
        );
        assert_eq!(
            contract.native_refund_liability, 75,
            "failed transfer must retain the liability"
        );
    }

    #[test]
    fn rust_terms_serialization_matches_shared_cross_language_golden_vector() {
        let vector: Value =
            serde_json::from_str(include_str!("../../test-vectors/terms-v1.json")).unwrap();
        let terms: EscrowTerms = serde_json::from_value(vector["terms"].clone()).unwrap();
        let canonical = serde_json::to_string(&terms).unwrap();
        assert_eq!(canonical, vector["canonicalJson"].as_str().unwrap());
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(canonical.as_bytes());
        assert_eq!(hex_encode(&digest), vector["sha256"].as_str().unwrap());
    }
}
