//! The colony layer the game UI needs on top of the Mind lifecycle:
//!
//! - **Supply cap**: only `MAX_SUPPLY` Minds will ever hatch.
//! - **Look**: the keeper's cosmetic choice (colour, eyes, hat, outfit, up to three
//!   natures), chosen at hatch and changeable later by the owner. Purely cosmetic — the
//!   seven trait dials that drive the AI voice stay rolled from block randomness.
//! - **Services**: a keeper publishes something their Mind is good at. Ordering one is a
//!   guest chat at the service's price (same 90/10 split, same yield/resume brain), so a
//!   service cannot be used to bypass the Mind's economics.
//! - **Sale**: a minimal built-in market. The owner lists a Mind at a price; anyone pays it
//!   and receives the Mind whole (food, memory, services). NEP-178 approvals still work for
//!   external marketplaces; this just makes "List for sale" work with no other contract.
//!
//! Lives in its own file as a child module of `contract`, so it can use the contract's
//! private state and helpers.

use super::*;
use near_sdk::store::LookupMap;

/// Only this many Minds will ever exist.
pub const MAX_SUPPLY: u64 = 4_000;

const TONES: u8 = 12;
const EYES: u8 = 11;
const HATS: u8 = 11;
const OUTFITS: u8 = 11;
const NATURES: u8 = 8;
const MAX_NATURES: usize = 3;

const MAX_TITLE: usize = 60;
const MAX_DESC: usize = 200;
const MAX_UNIT: usize = 16;
const CATEGORIES: u8 = 11; // predict, whales, data, yield, defi, risk, research, content, companion, agents, dev

/// A Mind's cosmetic look (indices into the game's glossy character parts).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Look {
    pub tone: u8,
    pub eyes: u8,
    pub hat: u8,
    pub outfit: u8,
    pub natures: Vec<u8>,
}

impl Look {
    pub fn assert_valid(&self) {
        require!(self.tone < TONES, "tone out of range");
        require!(self.eyes < EYES, "eyes out of range");
        require!(self.hat < HATS, "hat out of range");
        require!(self.outfit < OUTFITS, "outfit out of range");
        require!(self.natures.len() <= MAX_NATURES, "at most 3 natures");
        require!(self.natures.iter().all(|n| *n < NATURES), "nature out of range");
    }
}

/// A published service: a paid prompt to one Mind.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Service {
    pub id: u64,
    pub mind_id: u64,
    pub title: String,
    pub description: String,
    pub category: u8,
    /// Price per order (yoctoNEAR), never below the guest minimum.
    pub price: NearToken,
    pub unit: String,
    pub live: bool,
    pub orders: u64,
    /// Sum of what orders paid the Mind's owner (their 90%). Field name kept for state layout.
    pub fed: NearToken,
}

/// A Mind on sale in the built-in market.
#[near(serializers = [json])]
pub struct Listing {
    pub id: u64,
    pub name: String,
    pub owner: AccountId,
    pub price: NearToken,
}

/// One Mind as the game UI needs it: on-chain state plus the read-only "right now" views.
#[near(serializers = [json])]
pub struct MindRow {
    pub id: u64,
    pub mind: Mind,
    pub live_balance: NearToken,
    pub live_state: String,
    pub look: Option<Look>,
}

/// Everything the game screen shows, in one view call (public RPCs rate-limit hard, so
/// the UI polls this instead of ~5 views per Mind).
#[near(serializers = [json])]
pub struct Snapshot {
    pub params: EconomyParams,
    pub total_minds: u64,
    pub supply_left: u64,
    pub treasury: NearToken,
    pub ghost_window_ms: u64,
    pub minds: Vec<MindRow>,
    pub services: Vec<Service>,
    pub listings: Vec<Listing>,
}

/// The colony's extra state, kept beside the core so `Mind` itself stays unchanged.
#[near(serializers = [borsh])]
pub struct Colony {
    pub looks: LookupMap<u64, Look>,
    pub services: IterableMap<u64, Service>,
    pub next_service: u64,
    pub sales: IterableMap<u64, u128>,
}

impl Default for Colony {
    fn default() -> Self {
        Self {
            looks: LookupMap::new(b"l"),
            services: IterableMap::new(b"s"),
            next_service: 0,
            sales: IterableMap::new(b"x"),
        }
    }
}

/// Require the attached deposit to cover the storage a call just added; refund the rest.
pub(crate) fn charge_storage(before: u64) {
    let after = env::storage_usage();
    let used = after.saturating_sub(before) as u128;
    let cost = used * env::storage_byte_cost().as_yoctonear();
    let paid = env::attached_deposit().as_yoctonear();
    require!(paid >= cost, format!("attach at least {} yoctoNEAR to cover storage", cost));
    let refund = paid - cost;
    if refund > 0 {
        let _ = Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(refund));
    }
}

impl Contract {
    pub(crate) fn assert_owner(&self, mind_id: u64) -> &Mind {
        let m = self.minds.get(&mind_id).unwrap_or_else(|| env::panic_str("no such Mind"));
        require!((env::predecessor_account_id()) == (m.owner), "only the Mind's owner can do this");
        m
    }

    /// Clear a sale listing (called on every transfer so a sold/moved Mind isn't still listed).
    pub(crate) fn clear_listing(&mut self, id: u64) {
        self.colony.sales.remove(&id);
    }

    /// The guest-chat core shared by `chat` and `order_service`: a stranger pays at least
    /// `min` to talk; the Mind spends one thought from its own food; the deposit waits in
    /// escrow. A delivered reply releases it 90% owner / 10% protocol; a timeout refunds it.
    pub(crate) fn guest_think(&mut self, id: u64, prompt: String, min: u128, service_id: Option<u64>) -> Promise {
        require!(prompt.len() <= MAX_PROMPT_LEN, "prompt too long");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let deposit = env::attached_deposit().as_yoctonear();
        let cost = self.thought_cost;
        require!(deposit >= min, "chat deposit below the guest minimum");
        self.settle_metabolism(id, now);
        {
            let mind = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!(caller != mind.owner, "use think() for your own Mind");
            require!(!mind.ghost, "this Mind is a ghost");
            require!((mind.asleep_since) == (0), "this Mind is asleep: feed her to wake her (anyone can)");
        }
        // Never park a thought that was not actually charged (else a timeout would refund an
        // undebited cost and mint NEAR).
        let spent = self.minds.get_mut(&id).unwrap().spend_one_thought(now, cost);
        require!(spent, "this Mind cannot afford a thought right now");
        self.park_thought(id, prompt, false, cost, Some((caller, deposit, service_id)))
    }

    /// Validate and store a new service for one of the caller's Minds (storage is charged by
    /// the public method that calls this). Returns its id.
    pub(crate) fn add_service(&mut self, mind_id: u64, title: String, description: String, category: u8, price: U128, unit: String) -> u64 {
        {
            let m = self.assert_owner(mind_id);
            require!(!m.ghost, "a ghost cannot offer services");
        }
        require!(!title.trim().is_empty() && title.len() <= MAX_TITLE, "title must be 1..=60 bytes");
        require!(description.len() <= MAX_DESC, "description must be at most 200 bytes");
        require!(!unit.trim().is_empty() && unit.len() <= MAX_UNIT, "unit must be 1..=16 bytes");
        require!(category < CATEGORIES, "category out of range");
        require!(price.0 >= self.guest_min_price, "price must be at least the guest minimum");
        let id = self.colony.next_service;
        self.colony.next_service += 1;
        self.colony.services.insert(
            id,
            Service {
                id,
                mind_id,
                title,
                description,
                category,
                price: NearToken::from_yoctonear(price.0),
                unit,
                live: true,
                orders: 0,
                fed: NearToken::from_yoctonear(0),
            },
        );
        self.colony.services.flush();
        env::log_str(&format!("service_published id={id} mind={mind_id}"));
        id
    }

    /// A delivered order updates its service's stats.
    pub(crate) fn record_order(&mut self, service_id: u64, deposit: u128) {
        if let Some(s) = self.colony.services.get_mut(&service_id) {
            s.orders += 1;
            s.fed = s.fed.saturating_add(NearToken::from_yoctonear(economy::guest_split(deposit).to_owner));
        }
    }
}

#[near]
impl Contract {
    // ── supply ─────────────────────────────────────────────────────────────────

    pub fn max_supply(&self) -> u64 {
        MAX_SUPPLY
    }

    pub fn supply_left(&self) -> u64 {
        MAX_SUPPLY.saturating_sub(self.next_id)
    }

    /// How long a Mind may sleep before anyone can reap it into a ghost (30 days; 3 minutes
    /// on a `demo-window` build), so the UI never has to guess which build it is talking to.
    pub fn ghost_window_ms(&self) -> u64 {
        crate::state::GHOST_AFTER_NS / 1_000_000
    }

    /// A page of Minds (default 60) with live balance/state and look, plus params, supply,
    /// treasury, every service and every listing.
    pub fn colony_snapshot(&self, from_index: Option<u64>, limit: Option<u64>) -> Snapshot {
        let from = from_index.unwrap_or(0);
        let lim = limit.unwrap_or(60).min(60);
        let minds = (from..self.next_id.min(from + lim))
            .filter_map(|id| {
                self.minds.get(&id).map(|m| MindRow {
                    id,
                    mind: m.clone(),
                    live_balance: self.live_balance(id).unwrap_or(NearToken::from_yoctonear(0)),
                    live_state: self.live_state(id).unwrap_or_default(),
                    look: self.colony.looks.get(&id).cloned(),
                })
            })
            .collect();
        Snapshot {
            params: self.params(),
            total_minds: self.next_id,
            supply_left: self.supply_left(),
            treasury: self.treasury,
            ghost_window_ms: self.ghost_window_ms(),
            minds,
            services: self.services(None, None),
            listings: self.listings(None, None),
        }
    }

    // ── look ───────────────────────────────────────────────────────────────────

    pub fn get_look(&self, id: u64) -> Option<Look> {
        self.colony.looks.get(&id).cloned()
    }

    /// Owner changes their Mind's cosmetic look. Attach a little NEAR for storage the first
    /// time (excess refunded); later changes of the same size cost nothing.
    #[payable]
    pub fn set_look(&mut self, id: u64, look: Look) {
        self.assert_owner(id);
        look.assert_valid();
        let before = env::storage_usage();
        self.colony.looks.insert(id, look);
        self.colony.looks.flush();
        charge_storage(before);
    }

    // ── services ───────────────────────────────────────────────────────────────

    /// Publish a service for one of your Minds. Attach ~0.01 NEAR for its storage (excess
    /// refunded). Returns the service id.
    #[payable]
    pub fn publish_service(
        &mut self,
        mind_id: u64,
        title: String,
        description: String,
        category: u8,
        price: U128,
        unit: String,
    ) -> u64 {
        let before = env::storage_usage();
        let id = self.add_service(mind_id, title, description, category, price, unit);
        charge_storage(before);
        id
    }

    /// Pause or resume one of your services.
    pub fn set_service_live(&mut self, service_id: u64, live: bool) {
        let mind_id = self.colony.services.get(&service_id).unwrap_or_else(|| env::panic_str("no such service")).mind_id;
        self.assert_owner(mind_id);
        self.colony.services.get_mut(&service_id).unwrap().live = live;
    }

    pub fn get_service(&self, service_id: u64) -> Option<Service> {
        self.colony.services.get(&service_id).cloned()
    }

    /// A page of all services (paused ones included; the UI filters).
    pub fn services(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Service> {
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.map(|l| l.min(100)).unwrap_or(100) as usize;
        self.colony.services.values().skip(from).take(lim).cloned().collect()
    }

    pub fn services_for_mind(&self, mind_id: u64) -> Vec<Service> {
        self.colony.services.values().filter(|s| s.mind_id == mind_id).cloned().collect()
    }

    /// Order a service: a paid guest chat at the service's price (90% to the Mind's owner,
    /// 10% protocol). The worker sees the service title in the prompt.
    #[payable]
    pub fn order_service(&mut self, service_id: u64, prompt: String) -> Promise {
        let s = self.colony.services.get(&service_id).unwrap_or_else(|| env::panic_str("no such service")).clone();
        require!(s.live, "this service is paused");
        // An agent-run Mind's work is only sold as jobs, so her own agent does it.
        require!(!super::agents::has_agent(s.mind_id), "this Mind runs her own agent: order it with order_job");
        // The colony's model answers these, so it never sells data it would have to invent.
        require!(!super::agents::needs_agent(s.category), "this service needs an agent: order it with order_job once one is plugged in");
        let min = s.price.as_yoctonear().max(self.guest_min_price);
        let full = format!("[Service: {} — one {}] {}", s.title, s.unit, prompt);
        // MAX_PROMPT_LEN is in bytes: cut on a char boundary at or below it.
        let mut cut = full.len().min(MAX_PROMPT_LEN);
        while !full.is_char_boundary(cut) {
            cut -= 1;
        }
        // Orders and `fed` are counted when the reply is delivered (record_order).
        self.guest_think(s.mind_id, full[..cut].to_string(), min, Some(service_id))
    }

    // ── sale ───────────────────────────────────────────────────────────────────

    /// List your Mind for sale at `price`. Re-listing changes the price.
    pub fn list_for_sale(&mut self, id: u64, price: U128) {
        self.assert_owner(id);
        require!(price.0 > 0, "price must be positive");
        self.colony.sales.insert(id, price.0);
    }

    pub fn unlist(&mut self, id: u64) {
        self.assert_owner(id);
        self.clear_listing(id);
    }

    pub fn sale_price(&self, id: u64) -> Option<NearToken> {
        self.colony.sales.get(&id).map(|p| NearToken::from_yoctonear(*p))
    }

    pub fn listings(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Listing> {
        let from = from_index.unwrap_or(0) as usize;
        let lim = limit.map(|l| l.min(100)).unwrap_or(100) as usize;
        self.colony
            .sales
            .iter()
            .skip(from)
            .take(lim)
            .filter_map(|(id, p)| {
                self.minds.get(id).map(|m| Listing {
                    id: *id,
                    name: m.name.clone(),
                    owner: m.owner.clone(),
                    price: NearToken::from_yoctonear(*p),
                })
            })
            .collect()
    }

    /// Buy a listed Mind: attach at least its price. The seller is paid the price (plus their
    /// unclaimed cut, settled as on any transfer); any excess is refunded to the buyer.
    #[payable]
    pub fn buy_mind(&mut self, id: u64) {
        let price = *self.colony.sales.get(&id).unwrap_or_else(|| env::panic_str("this Mind is not for sale"));
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= price, "attach at least the sale price");
        let seller = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind")).owner.clone();
        require!(buyer != seller, "you already own this Mind");
        let (old_owner, cleared) = self.hand_over(id, &seller, &buyer, None, &Some("sale".into()));
        self.unplug_on_sale(id);
        refund_cleared_approvals(&cleared, &old_owner);
        let _ = Promise::new(old_owner).transfer(NearToken::from_yoctonear(price));
        if paid > price {
            let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(paid - price));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NEAR: u128 = 1_000_000_000_000_000_000_000_000;

    fn as_who(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("hm.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .random_seed([7; 32])
            .build());
    }

    fn look() -> Look {
        Look { tone: 3, eyes: 1, hat: 2, outfit: 4, natures: vec![0, 5] }
    }

    fn hatched_by_alice() -> Contract {
        as_who("alice.near", NEAR);
        let mut c = Contract::default();
        c.hatch_mind("Rue".into(), Some(look()));
        c
    }

    #[test]
    fn hatch_stores_the_chosen_look() {
        let c = hatched_by_alice();
        assert_eq!(c.get_look(0), Some(look()));
    }

    #[test]
    #[should_panic(expected = "at most 3 natures")]
    fn hatch_rejects_too_many_natures() {
        as_who("alice.near", 2 * NEAR);
        let mut c = Contract::default();
        c.hatch_mind("Rue".into(), Some(Look { natures: vec![0, 1, 2, 3], ..look() }));
    }

    #[test]
    #[should_panic(expected = "only 4000 Minds")]
    fn hatch_stops_at_the_supply_cap() {
        as_who("alice.near", 2 * NEAR);
        let mut c = Contract::default();
        c.next_id = MAX_SUPPLY;
        c.hatch_mind("Late".into(), None);
    }

    #[test]
    fn the_snapshot_carries_minds_looks_services_and_listings() {
        let mut c = with_service();
        as_who("alice.near", 0);
        c.list_for_sale(0, U128(3 * NEAR));
        let s = c.colony_snapshot(None, None);
        assert_eq!(s.total_minds, 1);
        assert_eq!(s.minds.len(), 1);
        assert_eq!(s.minds[0].look, Some(look()));
        assert_eq!(s.minds[0].live_state, "full");
        assert_eq!(s.services.len(), 1);
        assert_eq!(s.listings.len(), 1);
        assert_eq!(s.supply_left, MAX_SUPPLY - 1);
    }

    #[test]
    fn supply_left_counts_down() {
        let c = hatched_by_alice();
        assert_eq!(c.supply_left(), MAX_SUPPLY - 1);
    }

    #[test]
    fn owner_can_change_the_look() {
        let mut c = hatched_by_alice();
        as_who("alice.near", NEAR / 100);
        let l = Look { tone: 11, ..look() };
        c.set_look(0, l.clone());
        assert_eq!(c.get_look(0), Some(l));
    }

    #[test]
    #[should_panic(expected = "only the Mind's owner")]
    fn a_stranger_cannot_change_the_look() {
        let mut c = hatched_by_alice();
        as_who("bob.near", NEAR / 100);
        c.set_look(0, look());
    }

    fn with_service() -> Contract {
        let mut c = hatched_by_alice();
        as_who("alice.near", NEAR / 50);
        c.publish_service(0, "Tiny poem".into(), "Four lines about anything.".into(), 7, U128(NEAR / 25), "poem".into());
        c
    }

    #[test]
    fn publishing_lists_a_live_service() {
        let c = with_service();
        let s = c.services(None, None);
        assert_eq!(s.len(), 1);
        assert!(s[0].live);
        assert_eq!(s[0].mind_id, 0);
        assert_eq!(c.services_for_mind(0).len(), 1);
    }

    #[test]
    #[should_panic(expected = "at least the guest minimum")]
    fn a_service_cannot_undercut_the_guest_minimum() {
        let mut c = hatched_by_alice();
        as_who("alice.near", NEAR / 50);
        c.publish_service(0, "Cheap".into(), "".into(), 0, U128(1), "x".into());
    }

    #[test]
    #[should_panic(expected = "only the Mind's owner")]
    fn only_the_owner_can_publish() {
        let mut c = hatched_by_alice();
        as_who("bob.near", NEAR / 50);
        c.publish_service(0, "Mine now".into(), "".into(), 0, U128(NEAR / 50), "x".into());
    }

    #[test]
    fn ordering_pays_90_10_and_counts_the_order() {
        let mut c = with_service();
        let t0 = c.treasury.as_yoctonear();
        as_who("bob.near", NEAR / 25); // 0.04
        let _ = c.order_service(0, "about cats".into());
        assert_eq!(c.get_service(0).unwrap().orders, 0, "counted only once delivered");
        c.resolve_thought(0, 0, Ok("a poem".into()), 1);
        let m = c.get_mind(0).unwrap();
        // her food pays only the 0.002 thought; 90% of 0.04 goes to her owner
        assert_eq!(m.balance.as_yoctonear(), NEAR / 10 - NEAR * 2 / 1000);
        assert_eq!(m.owner_unclaimed.as_yoctonear(), NEAR * 36 / 1000);
        // 10% of 0.04, plus the 0.002 thought (no approved responder answered it)
        assert_eq!(c.treasury.as_yoctonear() - t0, NEAR * 4 / 1000 + NEAR * 2 / 1000);
        let s = c.get_service(0).unwrap();
        assert_eq!(s.orders, 1);
        assert_eq!(s.fed.as_yoctonear(), NEAR * 36 / 1000); // what it paid her owner
    }

    #[test]
    #[should_panic(expected = "below the guest minimum")]
    fn ordering_below_the_service_price_panics() {
        let mut c = with_service();
        as_who("bob.near", NEAR / 100); // 0.01 < 0.04
        let _ = c.order_service(0, "hi".into());
    }

    #[test]
    #[should_panic(expected = "this service is paused")]
    fn a_paused_service_cannot_be_ordered() {
        let mut c = with_service();
        as_who("alice.near", 0);
        c.set_service_live(0, false);
        as_who("bob.near", NEAR / 25);
        let _ = c.order_service(0, "hi".into());
    }

    #[test]
    fn a_listed_mind_can_be_bought_whole() {
        let mut c = hatched_by_alice();
        as_who("alice.near", 0);
        c.list_for_sale(0, U128(3 * NEAR));
        assert_eq!(c.listings(None, None).len(), 1);
        let bal = c.get_mind(0).unwrap().balance;
        as_who("bob.near", 3 * NEAR);
        c.buy_mind(0);
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.owner.as_str(), "bob.near");
        assert_eq!(m.balance, bal, "her food travels with her");
        assert!(c.sale_price(0).is_none(), "listing cleared");
        assert_eq!(c.get_look(0), Some(look()), "look travels with her");
    }

    #[test]
    #[should_panic(expected = "attach at least the sale price")]
    fn underpaying_for_a_mind_panics() {
        let mut c = hatched_by_alice();
        as_who("alice.near", 0);
        c.list_for_sale(0, U128(3 * NEAR));
        as_who("bob.near", NEAR);
        c.buy_mind(0);
    }

    #[test]
    #[should_panic(expected = "not for sale")]
    fn an_unlisted_mind_cannot_be_bought() {
        let mut c = hatched_by_alice();
        as_who("alice.near", 0);
        c.list_for_sale(0, U128(3 * NEAR));
        c.unlist(0);
        as_who("bob.near", 3 * NEAR);
        c.buy_mind(0);
    }

    #[test]
    fn a_plain_transfer_clears_the_listing() {
        let mut c = hatched_by_alice();
        as_who("alice.near", 1);
        c.list_for_sale(0, U128(3 * NEAR));
        c.nft_transfer("carol.near".parse().unwrap(), "0".into(), None, None);
        assert!(c.sale_price(0).is_none());
    }
}
