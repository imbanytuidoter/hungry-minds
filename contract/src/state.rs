//! Hunger state — derived purely from a Mind's balance (yoctoNEAR).
//!
//! The contract stores NO `state` field; the visible state (and the SVG the
//! wallet shows) is a pure function of `balance`, so per-token storage stays
//! tiny. Thresholds per build plan §16.3/§16.4.

/// 1 NEAR expressed in yoctoNEAR (10^24).
pub const ONE_NEAR: u128 = 1_000_000_000_000_000_000_000_000;

/// How a Mind looks and behaves, from the most alive to gone-to-sleep.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HungerState {
    Full,
    Content,
    Hungry,
    Starving,
    Asleep,
}

/// Derive the hunger state from the Mind's food balance (yoctoNEAR).
///
/// Full ≥ 0.5 NEAR · Content ≥ 0.1 · Hungry ≥ 0.02 · Starving > 0 · Asleep = 0.
/// (`Ghost` is a separate, time-based flag — not derived here.)
pub fn hunger_state(balance_yocto: u128) -> HungerState {
    const FULL: u128 = ONE_NEAR / 2; // 0.5 NEAR
    const CONTENT: u128 = ONE_NEAR / 10; // 0.1 NEAR
    const HUNGRY: u128 = ONE_NEAR / 50; // 0.02 NEAR

    if balance_yocto >= FULL {
        HungerState::Full
    } else if balance_yocto >= CONTENT {
        HungerState::Content
    } else if balance_yocto >= HUNGRY {
        HungerState::Hungry
    } else if balance_yocto > 0 {
        HungerState::Starving
    } else {
        HungerState::Asleep
    }
}

/// Nanoseconds in one day.
pub const NS_PER_DAY: u64 = 86_400 * 1_000_000_000;

/// How long a Mind must stay asleep before anyone may `reap` it into a ghost.
/// 30 days in production; a short window on the testnet demo build so judges
/// see the whole arc in minutes (`cargo near build --features demo-window`).
#[cfg(not(feature = "demo-window"))]
pub const GHOST_AFTER_NS: u64 = 30 * NS_PER_DAY;
#[cfg(feature = "demo-window")]
pub const GHOST_AFTER_NS: u64 = 3 * 60 * 1_000_000_000; // 3 minutes

/// Can this Mind be reaped into a ghost? Only if it has been continuously
/// asleep (`asleep_since != 0`) for at least `GHOST_AFTER_NS`.
pub fn is_reapable(asleep_since: u64, now: u64) -> bool {
    asleep_since != 0 && now.saturating_sub(asleep_since) >= GHOST_AFTER_NS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn awake_mind_is_never_reapable() {
        assert!(!is_reapable(0, 10 * GHOST_AFTER_NS));
    }

    #[test]
    fn freshly_asleep_mind_is_not_reapable() {
        let asleep = 1_000_000_000u64;
        assert!(!is_reapable(asleep, asleep + GHOST_AFTER_NS - 1));
    }

    #[test]
    fn long_asleep_mind_is_reapable() {
        let asleep = 1_000_000_000u64;
        assert!(is_reapable(asleep, asleep + GHOST_AFTER_NS));
    }

    #[test]
    fn zero_balance_is_asleep() {
        assert_eq!(hunger_state(0), HungerState::Asleep);
    }

    #[test]
    fn below_two_hundredths_near_is_starving() {
        assert_eq!(hunger_state(1), HungerState::Starving);
        assert_eq!(hunger_state(ONE_NEAR / 100), HungerState::Starving); // 0.01
    }

    #[test]
    fn five_hundredths_near_is_hungry() {
        assert_eq!(hunger_state(ONE_NEAR / 20), HungerState::Hungry); // 0.05
        assert_eq!(hunger_state(ONE_NEAR / 50), HungerState::Hungry); // exactly 0.02
    }

    #[test]
    fn fifth_of_a_near_is_content() {
        assert_eq!(hunger_state(ONE_NEAR / 5), HungerState::Content); // 0.2
        assert_eq!(hunger_state(ONE_NEAR / 10), HungerState::Content); // exactly 0.1
    }

    #[test]
    fn half_a_near_or_more_is_full() {
        assert_eq!(hunger_state(ONE_NEAR / 2), HungerState::Full); // exactly 0.5
        assert_eq!(hunger_state(ONE_NEAR), HungerState::Full);
        assert_eq!(hunger_state(ONE_NEAR * 10), HungerState::Full);
    }
}
