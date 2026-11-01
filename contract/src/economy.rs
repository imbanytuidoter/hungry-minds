//! Pure money-split logic (yoctoNEAR). Fixed constants per build plan §16.3.
//!
//! Every split CONSERVES the deposit (integer-division remainders are routed so
//! nothing is created or lost), and the Mind's own balance is favoured for the
//! remainder — it is the thing that must stay solvent.

use crate::state::ONE_NEAR;

/// Hatch price. Split: 1.0 seed -> Mind balance, 0.25 locked storage, rest -> treasury.
pub const MINT_PRICE: u128 = 2 * ONE_NEAR;
pub const MINT_SEED: u128 = ONE_NEAR; // 1.0 NEAR -> the newborn's own food
pub const MINT_STORAGE_RESERVE: u128 = ONE_NEAR / 4; // 0.25 NEAR locked for state

/// What one reply ("thought") burns from a Mind's balance. 1 NEAR ~= 500 thoughts.
pub const THOUGHT_COMPUTE_COST: u128 = ONE_NEAR / 500; // 0.002 NEAR

/// The minimum a stranger must attach to `chat`. It guarantees the guest covers the
/// thought they trigger — guest_split(GUEST_PRICE).to_mind = 0.007 NEAR, well above
/// THOUGHT_COMPUTE_COST — so a free-rider can never drain a Mind's own food.
pub const GUEST_PRICE: u128 = ONE_NEAR / 100; // 0.01 NEAR

#[derive(Debug, PartialEq, Eq)]
pub struct MintSplit {
    pub seed: u128,
    pub storage_reserve: u128,
    pub treasury: u128,
}

/// Split the hatch deposit. Requires `deposit >= MINT_PRICE`; any excess over the
/// fixed seed + storage reserve goes to treasury.
pub fn mint_split(deposit: u128) -> MintSplit {
    assert!(deposit >= MINT_PRICE, "hatch needs at least 2 NEAR");
    MintSplit {
        seed: MINT_SEED,
        storage_reserve: MINT_STORAGE_RESERVE,
        treasury: deposit - MINT_SEED - MINT_STORAGE_RESERVE,
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct GuestSplit {
    pub to_mind: u128,
    pub to_owner: u128,
    pub to_treasury: u128,
}

/// Guest pay-to-chat split: 70% Mind / 20% owner / 10% treasury (Mind keeps the remainder).
pub fn guest_split(deposit: u128) -> GuestSplit {
    let to_owner = deposit * 20 / 100;
    let to_treasury = deposit * 10 / 100;
    GuestSplit {
        to_mind: deposit - to_owner - to_treasury, // remainder favours the Mind
        to_owner,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mint_of_exactly_two_near_splits_1_025_075() {
        let s = mint_split(MINT_PRICE);
        assert_eq!(s.seed, ONE_NEAR);
        assert_eq!(s.storage_reserve, ONE_NEAR / 4);
        assert_eq!(s.treasury, ONE_NEAR * 3 / 4); // 0.75
        assert_eq!(s.seed + s.storage_reserve + s.treasury, MINT_PRICE);
    }

    #[test]
    fn mint_overpay_sends_excess_to_treasury() {
        let s = mint_split(3 * ONE_NEAR);
        assert_eq!(s.seed, ONE_NEAR);
        assert_eq!(s.storage_reserve, ONE_NEAR / 4);
        assert_eq!(s.treasury, 3 * ONE_NEAR - ONE_NEAR - ONE_NEAR / 4); // 1.75
        assert_eq!(s.seed + s.storage_reserve + s.treasury, 3 * ONE_NEAR);
    }

    #[test]
    fn guest_chat_of_one_hundredth_near_is_70_20_10() {
        let s = guest_split(ONE_NEAR / 100); // 0.01
        assert_eq!(s.to_mind, ONE_NEAR * 7 / 1000); // 0.007
        assert_eq!(s.to_owner, ONE_NEAR * 2 / 1000); // 0.002
        assert_eq!(s.to_treasury, ONE_NEAR / 1000); // 0.001
        assert_eq!(s.to_mind + s.to_owner + s.to_treasury, ONE_NEAR / 100);
    }

    #[test]
    fn guest_split_conserves_on_indivisible_amount() {
        let d = 7u128; // not divisible by 10
        let s = guest_split(d);
        assert_eq!(s.to_mind + s.to_owner + s.to_treasury, d);
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
}
