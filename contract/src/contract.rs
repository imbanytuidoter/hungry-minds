//! NEP-171 contract shell (scaffold).
//!
//! State is deliberately tiny per Mind: traits + a few ints + short name.
//! Everything derived (hunger state, mood, the SVG) is computed from these in
//! views, and all money math goes through the pure `economy` module. Real
//! methods (hatch / think+yield / feed / reap / chat / claim / svg_for /
//! transfer-with-everything) are added via TDD on top of this.

use near_sdk::store::IterableMap;
use near_sdk::{near, AccountId, NearToken};

/// One Mind's on-chain state.
#[near(serializers = [borsh])]
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
}
