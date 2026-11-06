//! Pure money-split logic (yoctoNEAR). Fixed splits + the DEFAULT values for the
//! governable price parameters per build plan §16.3.
//!
//! Every split CONSERVES the deposit (integer-division remainders are routed so
//! nothing is created or lost), and the Mind's own balance is favoured for the
//! remainder — it is the thing that must stay solvent.
//!
//! The three *prices* below (`THOUGHT_COMPUTE_COST`, `GUEST_PRICE`, `REVIVE_PRICE`)
//! are no longer hardcoded into the live methods: the `Contract` stores a live copy
//! of each, seeded from these consts, and the contract account may retune them
//! (see `Contract::set_*`). Economy design flag #1: the thought cost is a peg to the
//! real inference cost × NEAR price and MUST be tunable, never frozen. The split
//! *ratios* (hatch 1/0.25/rest, feed 95/5, guest 90/10, revive) stay fixed here.

use crate::state::ONE_NEAR;

/// Hatch price. Split: 0.1 seed -> Mind balance, 0.25 locked storage, rest -> treasury.
pub const MINT_PRICE: u128 = ONE_NEAR;
pub const MINT_SEED: u128 = ONE_NEAR / 10; // 0.1 NEAR -> the newborn's own food
pub const MINT_STORAGE_RESERVE: u128 = ONE_NEAR / 4; // 0.25 NEAR locked for state

/// DEFAULT for what one reply ("thought") burns from a Mind's balance. 1 NEAR ~= 500
/// thoughts. Governable: seeds `Contract::thought_cost`, retunable by the contract account.
pub const THOUGHT_COMPUTE_COST: u128 = ONE_NEAR / 500; // 0.002 NEAR

/// Hard ceiling on the governable thought cost. The contract account may raise the cost
/// (to re-peg to real inference price) but never above this, so a mis-set or hostile key
/// cannot make every Mind bankrupt itself in a single thought. 0.1 NEAR = at most ~10×
/// the default — far beyond any real inference peg, yet still a floor of ~10 thoughts/NEAR.
pub const MAX_THOUGHT_COST: u128 = ONE_NEAR / 10; // 0.1 NEAR

/// DEFAULT minimum a stranger must attach to `chat`. It guarantees the guest covers the
/// thought they trigger — guest_split(GUEST_PRICE).to_mind = 0.007 NEAR, well above the
/// default THOUGHT_COMPUTE_COST — so a free-rider can never drain a Mind's own food.
/// Governable: seeds `Contract::guest_min_price`.
pub const GUEST_PRICE: u128 = ONE_NEAR / 100; // 0.01 NEAR

/// DEFAULT minimum to attach to `revive` — the premium "instant comeback" for an asleep
/// Mind. Always optional: feeding a little or letting guests pay to chat also wakes a
/// Mind for free (just slower), so revive is never the only way back. Governable: seeds
/// `Contract::revive_price`.
pub const REVIVE_PRICE: u128 = ONE_NEAR / 10; // 0.1 NEAR

/// Treasury share of a `revive` deposit, in basis points. Higher than feed's 5%: revive is
/// a premium convenience, and the surplus over feed is the protocol's fee for it. The rest
/// goes into the Mind's (locked) food. 2000 bps = 20%.
pub const REVIVE_TREASURY_BPS: u128 = 2000;

#[derive(Debug, PartialEq, Eq)]
pub struct MintSplit {
    pub seed: u128,
    pub storage_reserve: u128,
    pub treasury: u128,
}

/// Split the hatch deposit. Requires `deposit >= MINT_PRICE`; any excess over the
/// fixed seed + storage reserve goes to treasury.
pub fn mint_split(deposit: u128) -> MintSplit {
    assert!(deposit >= MINT_PRICE, "hatch needs at least 1 NEAR");
    MintSplit {
        seed: MINT_SEED,
        storage_reserve: MINT_STORAGE_RESERVE,
        treasury: deposit - MINT_SEED - MINT_STORAGE_RESERVE,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct GuestSplit {
    pub to_owner: u128,
    pub to_treasury: u128,
}

/// What others pay to use a Mind (guest chat, service, job): 90% to her owner, 10% to the
/// protocol. None of it goes into her food: feeding her is her owner's job.
pub fn guest_split(deposit: u128) -> GuestSplit {
    let to_treasury = deposit * 10 / 100;
    GuestSplit {
        to_owner: deposit - to_treasury, // remainder favours the owner
        to_treasury,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct FeedSplit {
    pub to_mind: u128,
    pub to_treasury: u128,
}

/// Feed split: 95% Mind / 5% treasury. The 5% makes wash-feeding strictly loss-making.
pub fn feed_split(deposit: u128) -> FeedSplit {
    let to_treasury = deposit * 5 / 100;
    FeedSplit {
        to_mind: deposit - to_treasury, // remainder favours the Mind
        to_treasury,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct ReviveSplit {
    pub to_mind: u128,
    pub to_treasury: u128,
}

/// Revive split: `REVIVE_TREASURY_BPS` to treasury (the premium fee), the rest into the
/// Mind's locked food. Conserves the deposit; the remainder favours the Mind.
pub fn revive_split(deposit: u128) -> ReviveSplit {
    let to_treasury = deposit * REVIVE_TREASURY_BPS / 10_000;
    ReviveSplit {
        to_mind: deposit - to_treasury,
        to_treasury,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_of_exactly_one_near_splits_01_025_065() {
        let s = mint_split(MINT_PRICE);
        assert_eq!(s.seed, ONE_NEAR / 10);
        assert_eq!(s.storage_reserve, ONE_NEAR / 4);
        assert_eq!(s.treasury, ONE_NEAR * 65 / 100); // 0.65
        assert_eq!(s.seed + s.storage_reserve + s.treasury, MINT_PRICE);
    }

    #[test]
    fn mint_overpay_sends_excess_to_treasury() {
        let s = mint_split(3 * ONE_NEAR);
        assert_eq!(s.seed, ONE_NEAR / 10);
        assert_eq!(s.storage_reserve, ONE_NEAR / 4);
        assert_eq!(s.treasury, 3 * ONE_NEAR - ONE_NEAR / 10 - ONE_NEAR / 4); // 2.65
        assert_eq!(s.seed + s.storage_reserve + s.treasury, 3 * ONE_NEAR);
    }

    #[test]
    fn guest_payment_of_one_hundredth_near_is_90_10() {
        let s = guest_split(ONE_NEAR / 100); // 0.01
        assert_eq!(s.to_owner, ONE_NEAR * 9 / 1000); // 0.009
        assert_eq!(s.to_treasury, ONE_NEAR / 1000); // 0.001
        assert_eq!(s.to_owner + s.to_treasury, ONE_NEAR / 100);
    }

    #[test]
    fn guest_split_conserves_on_indivisible_amount() {
        let d = 7u128; // not divisible by 10
        let s = guest_split(d);
        assert_eq!(s.to_owner + s.to_treasury, d);
    }

    #[test]
    fn feed_is_95_5() {
        let s = feed_split(ONE_NEAR);
        assert_eq!(s.to_mind, ONE_NEAR * 95 / 100);
        assert_eq!(s.to_treasury, ONE_NEAR * 5 / 100);
        assert_eq!(s.to_mind + s.to_treasury, ONE_NEAR);
    }

    #[test]
    fn feed_conserves_on_indivisible_amount() {
        let d = 3u128;
        let s = feed_split(d);
        assert_eq!(s.to_mind + s.to_treasury, d);
    }

    #[test]
    fn revive_is_80_20_mind_treasury() {
        let s = revive_split(ONE_NEAR);
        assert_eq!(s.to_treasury, ONE_NEAR * 20 / 100); // 0.2
        assert_eq!(s.to_mind, ONE_NEAR * 80 / 100); // 0.8
        assert_eq!(s.to_mind + s.to_treasury, ONE_NEAR);
    }

    #[test]
    fn revive_conserves_on_indivisible_amount() {
        let d = 7u128;
        let s = revive_split(d);
        assert_eq!(s.to_mind + s.to_treasury, d); // remainder favours the Mind
    }

    #[test]
    fn default_prices_keep_a_guest_above_a_thought() {
        // A guest paying the default minimum must leave the Mind strictly better off
        // than the default thought it triggers costs it.
        let s = guest_split(GUEST_PRICE);
        assert!(s.to_owner > THOUGHT_COMPUTE_COST);
    }

    #[test]
    fn max_thought_cost_is_a_sane_ceiling() {
        assert!(MAX_THOUGHT_COST > THOUGHT_COMPUTE_COST);
        assert!(MAX_THOUGHT_COST < ONE_NEAR); // never a whole NEAR per thought
    }
}
