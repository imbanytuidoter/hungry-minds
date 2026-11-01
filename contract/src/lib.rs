//! Hungry Minds — core logic.
//!
//! Pure, near-sdk-free modules that the on-chain contract methods call into.
//! Testing the logic here (plain `cargo test`) keeps the TDD loop fast; the
//! NEP-171 contract shell is layered on in a later cycle.

pub mod contract;
pub mod economy;
pub mod state;
pub mod traits;
