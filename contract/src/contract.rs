//! NEP-171 contract shell.
//!
//! State is deliberately tiny per Mind: traits + a few ints + short name.
//! Everything derived (hunger state, mood, the SVG) is computed from these in
//! views, and all money math goes through the pure `economy` module. Methods
//! are built up via TDD. Full NEP-171 token registry is layered on later; the
//! Mind lifecycle (the product's value) comes first.

use crate::art::{self, Appearance};
use crate::state::{hunger_state, HungerState};
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

impl Mind {
    /// Charge the Mind for one thought. Returns true if it could think.
    /// A Mind that is a ghost, already asleep, or too poor to afford a reply
    /// cannot think; the moment it can no longer afford one it falls asleep
    /// (recording `now`, which starts the ghost clock).
    pub fn spend_one_thought(&mut self, now: u64) -> bool {
        if self.ghost || self.asleep_since != 0 {
            return false;
        }
        let cost = economy::THOUGHT_COMPUTE_COST;
        if self.balance.as_yoctonear() < cost {
            self.asleep_since = now;
            return false;
        }
        self.balance = NearToken::from_yoctonear(self.balance.as_yoctonear() - cost);
        self.last_think_ts = now;
        self.thought_count += 1;
        if self.balance.as_yoctonear() < cost {
            self.asleep_since = now; // just spent its last affordable thought
        }
        true
    }

    /// The life-state the art should show, derived from balance + flags.
    pub fn appearance(&self) -> Appearance {
        if self.ghost {
            return Appearance::Ghost;
        }
        if self.asleep_since != 0 {
            return Appearance::Asleep;
        }
        match hunger_state(self.balance.as_yoctonear()) {
            HungerState::Full => Appearance::Full,
            HungerState::Content => Appearance::Content,
            HungerState::Hungry => Appearance::Hungry,
            HungerState::Starving => Appearance::Starving,
            HungerState::Asleep => Appearance::Asleep,
        }
    }
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

// Internal, promise-free helpers (unit-tested directly; the public methods below
// orchestrate these and the OutLayer dispatch).
impl Contract {
    /// Credit a guest's pay-to-chat (70% Mind / 20% owner-unclaimed / 10% treasury)
    /// and spend the one thought the reply will cost.
    fn credit_guest_payment(&mut self, id: u64, deposit: u128, now: u64) {
        let split = economy::guest_split(deposit);
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        mind.balance = mind
            .balance
            .saturating_add(NearToken::from_yoctonear(split.to_mind));
        mind.owner_unclaimed = mind
            .owner_unclaimed
            .saturating_add(NearToken::from_yoctonear(split.to_owner));
        mind.spend_one_thought(now);
    }

    /// Take and zero the owner's accrued 20% cut. NEVER touches the Mind's balance.
    fn take_owner_earnings(&mut self, id: u64) -> NearToken {
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        let amount = mind.owner_unclaimed;
        mind.owner_unclaimed = NearToken::from_yoctonear(0);
        amount
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

    /// The Mind's visible state: ghost / asleep / starving / hungry / content / full.
    pub fn mind_state(&self, id: u64) -> Option<String> {
        self.minds.get(&id).map(|m| {
            if m.ghost {
                return "ghost".to_string();
            }
            if m.asleep_since != 0 {
                return "asleep".to_string();
            }
            match hunger_state(m.balance.as_yoctonear()) {
                HungerState::Full => "full",
                HungerState::Content => "content",
                HungerState::Hungry => "hungry",
                HungerState::Starving => "starving",
                HungerState::Asleep => "asleep",
            }
            .to_string()
        })
    }

    /// The Mind's current artwork as an inline SVG, assembled on-chain from its
    /// traits + live state. Always renders the *current* creature.
    pub fn svg_for(&self, id: u64) -> Option<String> {
        self.minds.get(&id).map(|m| {
            art::render(&art::Face {
                traits: m.traits,
                appearance: m.appearance(),
                name: &m.name,
            })
        })
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

    /// Feed a Mind: 95% to its balance, 5% to treasury. Wakes it if it can now
    /// afford a thought. Ghosts must be revived, not fed.
    #[payable]
    pub fn feed(&mut self, id: u64) {
        let split = economy::feed_split(env::attached_deposit().as_yoctonear());
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        assert!(!mind.ghost, "a ghost must be revived, not fed");
        mind.balance = mind
            .balance
            .saturating_add(NearToken::from_yoctonear(split.to_mind));
        if mind.asleep_since != 0 && mind.balance.as_yoctonear() >= economy::THOUGHT_COMPUTE_COST {
            mind.asleep_since = 0; // woke up
        }
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
    }

    /// The owner talks to their own Mind: spends one thought from its balance.
    pub fn think(&mut self, id: u64, prompt: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        assert_eq!(caller, mind.owner, "only the owner can use think()");
        assert!(!mind.ghost, "this Mind is a ghost — revive it first");
        assert!(mind.spend_one_thought(now), "this Mind is asleep — feed it");
        // The signed reply is produced off-chain by OutLayer TEE and resumed via a
        // yield/resume callback; wiring that dispatch is DAY-1 (ABI unconfirmed on testnet).
        env::log_str(&format!("thought_requested id={} by=owner len={}", id, prompt.len()));
    }

    /// A stranger pays to talk to a public Mind (70/20/10) and it thinks a reply.
    #[payable]
    pub fn chat(&mut self, id: u64, prompt: String) {
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let deposit = env::attached_deposit().as_yoctonear();
        {
            let mind = self.minds.get(&id).expect("no such Mind");
            assert!(caller != mind.owner, "use think() for your own Mind");
            assert!(!mind.ghost, "this Mind is a ghost");
            assert_eq!(mind.asleep_since, 0, "this Mind is asleep — only the owner can feed it");
        }
        self.credit_guest_payment(id, deposit, now);
        env::log_str(&format!("thought_requested id={} by=guest len={}", id, prompt.len()));
    }

    /// Owner withdraws only their accrued 20% guest-chat cut — never the Mind's food.
    pub fn claim_earnings(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        {
            let mind = self.minds.get(&id).expect("no such Mind");
            assert_eq!(caller, mind.owner, "only the owner can claim earnings");
        }
        let amount = self.take_owner_earnings(id);
        if amount.as_yoctonear() > 0 {
            // Dropping the Promise schedules it (near-sdk Promise::drop -> construct_recursively).
            let _ = near_sdk::Promise::new(caller).transfer(amount);
        }
    }

    /// Reap a Mind that has slept past `GHOST_AFTER_NS` into a ghost and refund
    /// its locked storage reserve to the owner. Callable by anyone (a keeper
    /// action); on the testnet demo build the window is minutes, not 30 days.
    pub fn reap(&mut self, id: u64) {
        let now = env::block_timestamp();
        let owner = {
            let mind = self.minds.get(&id).expect("no such Mind");
            assert!(!mind.ghost, "already a ghost");
            assert!(
                crate::state::is_reapable(mind.asleep_since, now),
                "not ready to reap — still within the sleep window"
            );
            mind.owner.clone()
        };
        self.minds.get_mut(&id).unwrap().ghost = true;
        // Return the 0.25 NEAR that was locked for this Mind's storage at hatch.
        let _ = near_sdk::Promise::new(owner)
            .transfer(NearToken::from_yoctonear(economy::MINT_STORAGE_RESERVE));
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

    fn make_mind(balance: NearToken, ghost: bool, asleep_since: u64) -> Mind {
        Mind {
            owner: "alice.near".parse().unwrap(),
            name: "T".to_string(),
            traits: [0; 7],
            balance,
            born_ts: 0,
            last_think_ts: 0,
            asleep_since,
            thought_count: 0,
            ghost,
            owner_unclaimed: NearToken::from_yoctonear(0),
        }
    }

    // --- hatch (already green) ---
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
        assert_eq!(m.balance, NearToken::from_near(1));
        assert_eq!(m.traits[0], 10 % traits::N_TEMPERAMENT);
        assert!(!m.ghost);
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(750));
    }

    #[test]
    #[should_panic(expected = "at least 2 NEAR")]
    fn hatch_below_two_near_panics() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("x".to_string());
    }

    // --- spend_one_thought ---
    #[test]
    fn thought_deducts_cost_and_bumps_count() {
        let mut m = make_mind(NearToken::from_near(1), false, 0);
        assert!(m.spend_one_thought(100));
        assert_eq!(
            m.balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR - economy::THOUGHT_COMPUTE_COST)
        );
        assert_eq!(m.thought_count, 1);
        assert_eq!(m.last_think_ts, 100);
        assert_eq!(m.asleep_since, 0);
    }

    #[test]
    fn broke_mind_cannot_think_and_falls_asleep() {
        let mut m = make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000), false, 0); // 0.001 < 0.002
        assert!(!m.spend_one_thought(200));
        assert_eq!(m.asleep_since, 200);
        assert_eq!(m.thought_count, 0);
    }

    #[test]
    fn asleep_and_ghost_minds_cannot_think() {
        let mut asleep = make_mind(NearToken::from_near(1), false, 50);
        assert!(!asleep.spend_one_thought(100));
        let mut ghost = make_mind(NearToken::from_near(1), true, 0);
        assert!(!ghost.spend_one_thought(100));
    }

    // --- feed ---
    #[test]
    fn feed_adds_95_to_mind_and_5_to_treasury() {
        testing_env!(ctx(NearToken::from_near(2), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string()); // balance 1.0, treasury 0.75

        testing_env!(ctx(NearToken::from_millinear(500), seed_all(0)).build()); // feed 0.5
        c.feed(0);

        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(1475)); // 1.0 + 0.475
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(775)); // 0.75 + 0.025
    }

    // --- mind_state ---
    #[test]
    fn mind_state_reports_each_state() {
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_near(1), false, 0)); // full
        c.minds
            .insert(1, make_mind(NearToken::from_millinear(50), false, 0)); // 0.05 hungry
        c.minds
            .insert(2, make_mind(NearToken::from_millinear(5), false, 0)); // 0.005 starving
        c.minds
            .insert(3, make_mind(NearToken::from_near(1), false, 99)); // asleep flag
        c.minds.insert(4, make_mind(NearToken::from_near(1), true, 0)); // ghost

        assert_eq!(c.mind_state(0).as_deref(), Some("full"));
        assert_eq!(c.mind_state(1).as_deref(), Some("hungry"));
        assert_eq!(c.mind_state(2).as_deref(), Some("starving"));
        assert_eq!(c.mind_state(3).as_deref(), Some("asleep"));
        assert_eq!(c.mind_state(4).as_deref(), Some("ghost"));
        assert_eq!(c.mind_state(99), None);
    }

    fn ctx_from(who: &str, deposit: NearToken) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(who.parse().unwrap())
            .attached_deposit(deposit)
            .random_seed(seed_all(0));
        b
    }

    // --- chat (guest) ---
    #[test]
    fn guest_chat_pays_70_20_10_and_spends_a_thought() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string()); // balance 1.0, treasury 0.75

        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build()); // guest pays 0.01
        c.chat(0, "hi".to_string());

        let m = c.get_mind(0).unwrap();
        // 1.0 + 0.007 (to mind) - 0.002 (thought) = 1.005
        assert_eq!(m.balance, NearToken::from_millinear(1005));
        assert_eq!(m.owner_unclaimed, NearToken::from_millinear(2)); // 0.002
        assert_eq!(m.thought_count, 1);
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(751)); // 0.75 + 0.001
    }

    #[test]
    #[should_panic(expected = "your own Mind")]
    fn owner_cannot_use_chat() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.chat(0, "hi".to_string());
    }

    // --- think (owner) ---
    #[test]
    fn owner_think_spends_a_thought_without_payment() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(0)).build());
        c.think(0, "hey".to_string());

        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(998)); // 1.0 - 0.002
        assert_eq!(m.thought_count, 1);
        assert_eq!(m.owner_unclaimed, NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(750)); // unchanged
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn non_owner_cannot_use_think() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(0)).build());
        c.think(0, "hi".to_string());
    }

    // --- the no-withdraw invariant ---
    #[test]
    fn claiming_earnings_never_touches_the_mind_balance() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        // a guest chat accrues owner_unclaimed and raises the Mind's own balance
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        c.chat(0, "hi".to_string());
        let balance_before = c.get_mind(0).unwrap().balance;

        let taken = c.take_owner_earnings(0);

        assert_eq!(taken, NearToken::from_millinear(2)); // only the 20% cut
        assert_eq!(c.get_mind(0).unwrap().owner_unclaimed, NearToken::from_yoctonear(0));
        assert_eq!(c.get_mind(0).unwrap().balance, balance_before); // Mind's food untouched
    }

    // --- appearance / svg_for ---
    #[test]
    fn appearance_follows_balance_and_flags() {
        assert_eq!(make_mind(NearToken::from_near(1), false, 0).appearance(), Appearance::Full);
        assert_eq!(make_mind(NearToken::from_millinear(50), false, 0).appearance(), Appearance::Hungry);
        assert_eq!(make_mind(NearToken::from_millinear(5), false, 0).appearance(), Appearance::Starving);
        assert_eq!(make_mind(NearToken::from_near(1), false, 7).appearance(), Appearance::Asleep);
        assert_eq!(make_mind(NearToken::from_near(1), true, 0).appearance(), Appearance::Ghost);
    }

    #[test]
    fn svg_for_renders_current_state_and_is_none_when_absent() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0)); // full
        c.minds.insert(1, make_mind(NearToken::from_near(1), true, 0)); // ghost
        let full = c.svg_for(0).expect("some");
        let ghost = c.svg_for(1).expect("some");
        assert!(full.trim_start().starts_with("<svg"));
        assert_ne!(full, ghost, "a ghost must not look like a full Mind");
        assert_eq!(c.svg_for(99), None);
    }

    // --- reap -> ghost ---
    fn ctx_at(who: &str, ts: u64) -> VMContextBuilder {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(who.parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(0))
            .block_timestamp(ts)
            .random_seed(seed_all(0));
        b
    }

    #[test]
    fn long_asleep_mind_can_be_reaped_into_a_ghost() {
        let asleep = 1_000_000_000u64;
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_yoctonear(0), false, asleep));
        testing_env!(ctx_at("keeper.near", asleep + crate::state::GHOST_AFTER_NS).build());
        c.reap(0);
        assert!(c.get_mind(0).unwrap().ghost);
        assert_eq!(c.mind_state(0).as_deref(), Some("ghost"));
    }

    #[test]
    #[should_panic(expected = "not ready to reap")]
    fn a_recently_asleep_mind_cannot_be_reaped() {
        let asleep = 1_000_000_000u64;
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_yoctonear(0), false, asleep));
        testing_env!(ctx_at("keeper.near", asleep + crate::state::GHOST_AFTER_NS - 1).build());
        c.reap(0);
    }

    #[test]
    #[should_panic(expected = "already a ghost")]
    fn a_ghost_cannot_be_reaped_again() {
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_yoctonear(0), true, 500));
        testing_env!(ctx_at("keeper.near", u64::MAX).build());
        c.reap(0);
    }
}
