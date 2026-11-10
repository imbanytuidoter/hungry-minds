//! Hungry Minds contract.
//!
//! `contract` is the NEP-171 contract (with colony, chat and agents as child modules);
//! `economy`, `state`, `traits` and the art modules are pure logic, unit-tested without a chain.

pub mod art;
pub mod contract;
pub mod economy;
pub mod glossy;
pub mod glossy_parts;
pub mod state;
pub mod traits;
