//! WorkRelay Test Token (WRT): a no-monetary-value NEP-141 test asset.
//! Owner-only minting is intentionally limited to sandbox/testnet chain IDs.

use near_contract_standards::fungible_token::core::FungibleTokenCore;
use near_contract_standards::fungible_token::metadata::{
    FungibleTokenMetadata, FungibleTokenMetadataProvider, FT_METADATA_SPEC,
};
use near_contract_standards::fungible_token::resolver::FungibleTokenResolver;
use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::U128;
use near_sdk::log;
use near_sdk::BorshStorageKey;
use near_sdk::{assert_one_yocto, env, near, AccountId, NearToken, PanicOnDefault};

#[derive(BorshSerialize, BorshStorageKey)]
enum StorageKey {
    Accounts,
    Metadata,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WorkRelayTestToken {
    token: FungibleToken,
    metadata: LazyOption<FungibleTokenMetadata>,
    owner_id: AccountId,
}

#[near]
impl WorkRelayTestToken {
    /// Initialize only on NEAR testnet or a local Sandbox chain.
    #[init]
    pub fn new(owner_id: AccountId) -> Self {
        assert_supported_chain();
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "Only the token account itself may initialize the contract"
        );
        let storage_before = env::storage_usage();
        let mut token = FungibleToken::new(StorageKey::Accounts);
        token.internal_register_account(&owner_id);
        let metadata_record = workrelay_token_metadata();
        let metadata = LazyOption::new(StorageKey::Metadata, Some(&metadata_record));
        let bytes_added = env::storage_usage()
            .checked_sub(storage_before)
            .expect("Token initialization must increase storage");
        let required = (bytes_added as u128)
            .checked_mul(env::storage_byte_cost().as_yoctonear())
            .expect("Token initialization storage cost overflow");
        // Initialization is a self-call. The deployed token account itself
        // must already hold enough liquid NEAR to cover its initial storage.
        assert!(
            env::account_balance().as_yoctonear() >= required,
            "Token contract account must be funded for initialization storage",
        );
        Self {
            token,
            metadata,
            owner_id,
        }
    }

    /// Owner-only test mint. The token has no monetary value and is not USDC.
    #[payable]
    pub fn mint(&mut self, receiver_id: AccountId, amount: U128) {
        assert_supported_chain();
        assert_one_yocto();
        assert_eq!(
            env::predecessor_account_id(),
            self.owner_id,
            "Only test-token owner may mint"
        );
        if let Some(message) =
            mint_validation_error(amount.0, self.token.accounts.contains_key(&receiver_id))
        {
            env::panic_str(message);
        }
        self.token.total_supply = self
            .token
            .total_supply
            .checked_add(amount.0)
            .expect("Total supply overflow");
        self.token.internal_deposit(&receiver_id, amount.0);
        log!("EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_mint\",\"data\":[{{\"owner_id\":\"{}\",\"amount\":\"{}\"}}]}}", receiver_id, amount.0);
    }

    pub fn get_token_notice(&self) -> String {
        workrelay_token_notice().to_string()
    }

    pub fn get_owner_id(&self) -> AccountId {
        self.owner_id.clone()
    }
}

#[near]
impl FungibleTokenCore for WorkRelayTestToken {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        self.token.ft_transfer(receiver_id, amount, memo)
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> near_sdk::PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for WorkRelayTestToken {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token
            .ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for WorkRelayTestToken {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        if let Some((account_id, balance)) = self.token.internal_storage_unregister(force) {
            if balance > 0 {
                self.token.total_supply = self
                    .token
                    .total_supply
                    .checked_sub(balance)
                    .expect("Total supply underflow");
            }
            log!("EVENT_JSON:{{\"standard\":\"nep141\",\"version\":\"1.0.0\",\"event\":\"ft_burn\",\"data\":[{{\"owner_id\":\"{}\",\"amount\":\"{}\"}}]}}", account_id, balance);
            true
        } else {
            false
        }
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenMetadataProvider for WorkRelayTestToken {
    fn ft_metadata(&self) -> FungibleTokenMetadata {
        self.metadata.get().expect("Token metadata must exist")
    }
}

fn workrelay_token_metadata() -> FungibleTokenMetadata {
    FungibleTokenMetadata {
        spec: FT_METADATA_SPEC.to_string(),
        name: "WorkRelay Test Token — No Monetary Value".to_string(),
        symbol: "WRT".to_string(),
        icon: None,
        reference: None,
        reference_hash: None,
        decimals: 6,
    }
}

fn workrelay_token_notice() -> &'static str {
    "WRT is a WorkRelay test token with no real monetary value. It is not USDC and cannot be used for Agent Market payment."
}

fn mint_validation_error(amount: u128, receiver_registered: bool) -> Option<&'static str> {
    if amount == 0 {
        Some("Mint amount must be positive")
    } else if !receiver_registered {
        Some("Receiver must register via storage_deposit first")
    } else {
        None
    }
}

fn assert_supported_chain() {
    let chain_id = env::chain_id();
    assert!(
        chain_id == "testnet" || chain_id == "sandbox",
        "WRT may only be initialized/used on testnet or local Sandbox"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_metadata_is_explicitly_wrt_with_six_decimals() {
        let metadata = workrelay_token_metadata();
        assert_eq!(metadata.symbol, "WRT");
        assert_eq!(metadata.decimals, 6);
        assert!(metadata.name.contains("No Monetary Value"));
        assert!(workrelay_token_notice().contains("not USDC"));
    }

    #[test]
    fn mint_rejects_zero_amount() {
        assert_eq!(
            mint_validation_error(0, true),
            Some("Mint amount must be positive"),
        );
    }

    #[test]
    fn mint_rejects_unregistered_receiver() {
        assert_eq!(
            mint_validation_error(1, false),
            Some("Receiver must register via storage_deposit first"),
        );
    }

    #[test]
    fn mint_accepts_positive_amount_for_registered_receiver() {
        assert_eq!(mint_validation_error(1, true), None);
    }
}
