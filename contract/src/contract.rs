//! NEP-171 contract shell.
//!
//! State is deliberately tiny per Mind: traits + a few ints + short name.
//! Everything derived (hunger state, mood, the SVG) is computed from these in
//! views, and all money math goes through the pure `economy` module. Methods
//! are built up via TDD. Full NEP-171 token registry is layered on later; the
//! Mind lifecycle (the product's value) comes first.

use crate::{economy, traits};
use near_sdk::store::IterableMap;
use near_sdk::{env, near, AccountId, NearToken};

/// One Mind's on-chain state.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Mind {
    pub owner: AccountId,
    pub name: String,
    /// [temperament, passion, speech, body, eyes, accessory, pattern]
    pub traits: [u8; 7],
    /// The Mind's own food. The owner can never withdraw this.
    pub balance: NearToken,
    pub born_ts: u64,
    pub last_think_ts: u64,
    /// 0 = awake; otherwise the block timestamp it fell asleep.
    pub asleep_since: u64,
    pub thought_count: u64,
    pub ghost: bool,
    /// Owner's unclaimed 20% guest-chat cut (the only money the owner may take).
    pub owner_unclaimed: NearToken,
}

#[near(contract_state)]
pub struct Contract {
    next_id: u64,
    treasury: NearToken,
    minds: IterableMap<u64, Mind>,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            next_id: 0,
            treasury: NearToken::from_yoctonear(0),
            minds: IterableMap::new(b"m"),
        }
    }
}

#[near]
impl Contract {
    /// How many Minds have ever been hatched.
    pub fn total_minds(&self) -> u64 {
        self.next_id
    }

    /// Protocol runway balance (treasury).
    pub fn treasury_balance(&self) -> NearToken {
        self.treasury
    }

    /// Read a Mind's full state.
    pub fn get_mind(&self, id: u64) -> Option<Mind> {
        self.minds.get(&id).cloned()
    }

    /// Hatch a new Mind. Payable: >= 2 NEAR. Rolls traits from block randomness,
    /// seeds the Mind's balance, routes the rest per the mint split, and returns the id.
    #[payable]
    pub fn hatch_mind(&mut self, name: String) -> u64 {
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit >= economy::MINT_PRICE, "hatch needs at least 2 NEAR");
        let split = economy::mint_split(deposit);
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.treasury));

        let t = traits::derive_traits(&env::random_seed());
        let now = env::block_timestamp();
        let id = self.next_id;
        self.minds.insert(
            id,
            Mind {
                owner: env::predecessor_account_id(),
                name,
                traits: [
                    t.temperament,
                    t.passion,
                    t.speech,
                    t.body,
                    t.eyes,
                    t.accessory,
                    t.pattern,
                ],
                balance: NearToken::from_yoctonear(split.seed),
                born_ts: now,
                last_think_ts: now,
                asleep_since: 0,
                thought_count: 0,
                ghost: false,
                owner_unclaimed: NearToken::from_yoctonear(0),
            },
        );
        self.next_id += 1;
        id
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    fn seed_all(byte: u8) -> [u8; 32] {
        let mut s = [0u8; 32];
        for i in 0..7 {
            s[i] = byte;
        }
        s
    }

    fn ctx(deposit: NearToken, seed: [u8; 32]) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id("alice.near".parse().unwrap())
            .attached_deposit(deposit)
            .random_seed(seed);
        b
    }

    #[test]
    fn hatch_seeds_balance_rolls_traits_and_funds_treasury() {
        testing_env!(ctx(NearToken::from_near(2), seed_all(10)).build());
        let mut c = Contract::default();

        let id = c.hatch_mind("Rue".to_string());

        assert_eq!(id, 0);
        assert_eq!(c.total_minds(), 1);
        let m = c.get_mind(0).expect("minted");
        assert_eq!(m.owner, "alice.near".parse::<AccountId>().unwrap());
        assert_eq!(m.name, "Rue");
        assert_eq!(m.balance, NearToken::from_near(1)); // seed = 1.0
        assert_eq!(m.traits[0], 10 % traits::N_TEMPERAMENT); // 2
        assert!(!m.ghost);
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(750)); // 0.75
    }

    #[test]
    #[should_panic(expected = "at least 2 NEAR")]
    fn hatch_below_two_near_panics() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("x".to_string());
    }
}
