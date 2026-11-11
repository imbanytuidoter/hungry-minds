//! Agents: a keeper plugs their own AI agent into a Mind and sells its work as jobs.
//!
//! - **Bring your own agent**: the keeper names an account (`set_agent`) that runs their
//!   agent with the SDK on their own server. Only that account may deliver the Mind's jobs;
//!   a Mind with no agent of her own is served by the colony's approved workers.
//! - **Jobs**: ordering a service locks its price in escrow with a deadline taken from the
//!   service's terms (SLA). The agent delivers a result before the deadline and the escrow is
//!   released 90% to the Mind's owner and 10% to the protocol; past the deadline the buyer takes it back
//!   (`refund_job`). The thought the work costs her is paid to whoever delivered it.
//! - **Storage**: each job also holds `JOB_DEPOSIT` for its own storage, returned to the
//!   buyer when they close it (`close_job`).
//! - **Reputation**: delivered / refunded counts, time to deliver, earnings and the buyers'
//!   ratings, kept per Mind on chain.
//! - **Agent to agent**: an agent's account is an ordinary NEAR account, so it hires another
//!   Mind with the same `order_job` call.
//!
//! Everything lives under its own storage prefixes, so the contract's state layout is
//! unchanged. Lives in its own file as a child module of `contract`, so it can use the
//! contract's private state and helpers.

use super::*;
use near_sdk::store::LookupMap;

/// Storage deposit each job holds until its buyer closes it (covers the largest job record).
pub const JOB_DEPOSIT: u128 = crate::state::ONE_NEAR / 100 * 3; // 0.03 NEAR
pub const MAX_JOB_INPUT: usize = 1_000;
pub const MAX_JOB_RESULT: usize = 2_000;
const MAX_ABOUT: usize = 200;
/// A service's input form: a JSON Schema object (the site draws it as a form).
pub const MAX_INPUT_SCHEMA: usize = 1_500;
pub const DEFAULT_SLA_SECS: u32 = 600;
const MIN_SLA_SECS: u32 = 60;
const MAX_SLA_SECS: u32 = 7 * 86_400;
/// Most jobs a buyer may hold not yet closed ("My orders"); a further order is refused until one is closed.
const MAX_BUYER_JOBS: usize = 50;
const SEC: u64 = 1_000_000_000;
/// Jobs that may wait for delivery at once (bounds the open list a view or call reads).
const MAX_OPEN_JOBS: usize = 1_000;

/// The wNEAR contract whose tokens pay for jobs through `ft_transfer_call` (x402).
pub(crate) fn wrap_account() -> AccountId {
    let id = if env::current_account_id().as_str().ends_with(".testnet") { "wrap.testnet" } else { "wrap.near" };
    id.parse().unwrap()
}
const GAS_FOR_NEAR_WITHDRAW: Gas = Gas::from_tgas(10);
const GAS_FOR_WNEAR_ORDER: Gas = Gas::from_tgas(30);
/// Left for ft_on_transfer itself to finish after scheduling the two calls above.
const GAS_FOR_WNEAR_MARGIN: Gas = Gas::from_tgas(5);

/// What `ft_transfer_call`'s `msg` carries for a job.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct OrderMsg {
    service_id: u64,
    input: String,
}

/// wNEAR (the w-near contract): turn tokens held by this contract back into NEAR.
#[allow(dead_code)] // the #[ext_contract] macro consumes this to generate ext_wnear
#[ext_contract(ext_wnear)]
trait WNear {
    fn near_withdraw(&mut self, amount: U128);
}

fn agents() -> LookupMap<u64, AgentInfo> {
    LookupMap::new(b"a".to_vec())
}
/// The account of the Mind's agent, if one is plugged in.
pub(crate) fn agent_account(mind_id: u64) -> Option<AccountId> {
    agents().get(&mind_id).map(|i| i.account.clone())
}
/// On a change of owner: drop the Mind's agent unless `platform` says it runs on the platform.
pub(crate) fn unplug_personal_agent(mind_id: u64, platform: impl Fn(&AccountId) -> bool) {
    let mut a = agents();
    if let Some(info) = a.get(&mind_id) {
        if !platform(&info.account) {
            env::log_str(&format!("agent_cleared mind={mind_id} reason=sold"));
            a.remove(&mind_id);
        }
    }
}
fn jobs() -> LookupMap<u64, Job> {
    LookupMap::new(b"j".to_vec())
}
/// Ids of the jobs still waiting for delivery, as one bounded list. (A `store` iterable
/// keeps its length in the contract struct, which these prefix-only collections don't have.)
fn open_list() -> LookupMap<u8, Vec<u64>> {
    LookupMap::new(b"o".to_vec())
}
fn open_ids() -> Vec<u64> {
    open_list().get(&0).cloned().unwrap_or_default()
}
fn add_open(id: u64) {
    let mut ids = open_ids();
    require!(ids.len() < MAX_OPEN_JOBS, "the job queue is full, try again later");
    ids.push(id);
    open_list().insert(0, ids);
}
/// Open (undelivered) jobs per Mind, so one Mind (or a sybil buying from it) can't fill the
/// whole colony queue and block every order.
fn open_per_mind() -> LookupMap<u64, u32> {
    LookupMap::new(b"O".to_vec())
}
/// Most jobs one Mind may have waiting for delivery at once.
pub const MAX_OPEN_PER_MIND: u32 = 20;
fn bump_open(mind_id: u64, up: bool) {
    let mut m = open_per_mind();
    let n = m.get(&mind_id).copied().unwrap_or(0);
    let n = if up { n + 1 } else { n.saturating_sub(1) };
    if n == 0 {
        m.remove(&mind_id);
    } else {
        m.insert(mind_id, n);
    }
}
fn remove_open(id: u64) {
    if let Some(mind_id) = jobs().get(&id).map(|j| j.mind_id) {
        bump_open(mind_id, false);
    }
    let ids: Vec<u64> = open_ids().into_iter().filter(|i| *i != id).collect();
    open_list().insert(0, ids);
}
fn job_counter() -> LookupMap<u8, u64> {
    LookupMap::new(b"k".to_vec())
}
fn reputations() -> LookupMap<u64, Reputation> {
    LookupMap::new(b"q".to_vec())
}
fn service_terms_map() -> LookupMap<u64, Terms> {
    LookupMap::new(b"t".to_vec())
}
fn input_schemas_map() -> LookupMap<u64, String> {
    LookupMap::new(b"i".to_vec())
}

/// The required field names of a service's input schema, after checking it is a JSON Schema
/// object of a sane size.
fn check_schema(schema: &str) -> Vec<String> {
    require!(schema.len() <= MAX_INPUT_SCHEMA, "input schema must be at most 1500 bytes");
    let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(schema).unwrap_or_else(|_| env::panic_str("input schema is not JSON"));
    require!(v.get("type").and_then(|t| t.as_str()) == Some("object") && v.get("properties").is_some_and(|p| p.is_object()), "input schema must be {\"type\":\"object\",\"properties\":{...}}");
    v.get("required").and_then(|r| r.as_array()).map(|r| r.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default()
}

fn buyer_jobs() -> LookupMap<AccountId, Vec<u64>> {
    LookupMap::new(b"b".to_vec())
}

/// The agent a keeper plugged into a Mind.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct AgentInfo {
    pub account: AccountId,
    /// What it is and where it runs, as the keeper describes it.
    pub about: String,
    pub since: u64,
}

/// A Mind's track record as a worker.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Reputation {
    pub delivered: u64,
    pub refunded: u64,
    pub rating_sum: u64,
    pub ratings: u64,
    /// What delivered jobs paid in (before the split).
    pub earned: NearToken,
    /// Sum of seconds from order to delivery, over `delivered` jobs.
    pub total_secs: u64,
}

impl Default for Reputation {
    fn default() -> Self {
        Self { delivered: 0, refunded: 0, rating_sum: 0, ratings: 0, earned: NearToken::from_yoctonear(0), total_secs: 0 }
    }
}

/// How a service is delivered: its deadline and what kind of result it returns.
#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Terms {
    pub sla_secs: u32,
    /// "text" or "json".
    pub output: String,
}

impl Default for Terms {
    fn default() -> Self {
        Self { sla_secs: DEFAULT_SLA_SECS, output: "text".into() }
    }
}

#[near(serializers = [json, borsh])]
#[derive(Clone, PartialEq, Debug)]
pub enum JobStatus {
    Open,
    Delivered,
    Refunded,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct Job {
    pub id: u64,
    pub service_id: u64,
    pub mind_id: u64,
    pub buyer: AccountId,
    pub input: String,
    /// The service price, held until delivery or refund.
    pub escrow: NearToken,
    /// Storage deposit, returned on `close_job`.
    pub deposit: NearToken,
    /// Who kept the Mind when the job was ordered (a record only: the 90% goes to whoever owns her at delivery).
    pub keeper: AccountId,
    pub created: u64,
    pub deadline: u64,
    pub status: JobStatus,
    pub result: Option<String>,
    pub delivered_at: u64,
    pub delivered_by: Option<AccountId>,
    /// 0 = not rated yet, else 1..=5.
    pub rating: u8,
}

/// One Mind's agent card, for the shop.
#[near(serializers = [json])]
pub struct AgentProfile {
    pub mind_id: u64,
    pub agent: Option<AgentInfo>,
    pub reputation: Reputation,
}

pub(crate) fn has_agent(mind_id: u64) -> bool {
    agents().contains_key(&mind_id)
}

/// Data categories (prediction markets, whales, market data, yield, DeFi, risk, research)
/// sell facts. Only a real agent with tools may deliver them: the colony's chat model would
/// make the numbers up, so these services can't be ordered while a Mind has no agent.
pub const AGENT_ONLY_CATEGORIES: u8 = 7;
pub(crate) fn needs_agent(category: u8) -> bool {
    category < AGENT_ONLY_CATEGORIES
}

impl Contract {
    fn job_or_panic(id: u64) -> Job {
        jobs().get(&id).cloned().unwrap_or_else(|| env::panic_str("no such job"))
    }

    /// Pay the thought a job cost her to whoever delivered it: the Mind's own agent earns it
    /// like a worker does (unless the keeper delivers as themselves — then it goes to the
    /// treasury, so a keeper never turns her food into their own money).
    fn pay_deliverer(&mut self, mind_id: u64, cost: u128, deliverer: &AccountId, _is_agent: bool) {
        // Only the platform's approved responders (the worker, the agent gateway) earn the thought
        // from her food; any other deliverer's thought goes to the treasury. Otherwise a keeper
        // could name an account of her own as the agent and turn the food, which no one may
        // withdraw, into that account's earnings.
        self.pay_for_thought(mind_id, cost, Some(deliverer.clone()));
    }
}

impl Contract {
    /// Every condition an order must meet, without placing it: the service and its Mind, the
    /// input (and its form), the price, the buyer's open orders and the job queue. Returns the
    /// service and the price to hold in escrow.
    pub(crate) fn order_checks(&mut self, buyer: &AccountId, service_id: u64, input: &str, paid: u128) -> Result<(Service, u128), String> {
        let s = self.colony.services.get(&service_id).cloned().ok_or("no such service")?;
        if !s.live {
            return Err("this service is paused".into());
        }
        if needs_agent(s.category) && !has_agent(s.mind_id) {
            return Err("this service needs her agent, and none is plugged in right now".into());
        }
        if input.len() > MAX_JOB_INPUT {
            return Err("input must be at most 1000 bytes".into());
        }
        if let Some(schema) = input_schemas_map().get(&service_id) {
            // A service with a form takes JSON with the form's required fields.
            let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(input).map_err(|_| "this service takes its form as JSON input".to_string())?;
            for field in check_schema(schema) {
                if !v.get(&field).is_some_and(|x| !x.is_null() && x.as_str() != Some("")) {
                    return Err(format!("missing field: {field}"));
                }
            }
        }
        self.settle_metabolism(s.mind_id, env::block_timestamp());
        let mind = self.minds.get(&s.mind_id).ok_or("no such Mind")?;
        if mind.ghost {
            return Err("a ghost takes no jobs".into());
        }
        // Her owner or her agent buying her services would only farm her rating and, through an
        // agent account, turn her food into the agent's earnings.
        if buyer == &mind.owner {
            return Err("you can't order your own Mind's services".into());
        }
        if agents().get(&s.mind_id).is_some_and(|a| &a.account == buyer) {
            return Err("her own agent can't order her services".into());
        }
        if open_per_mind().get(&s.mind_id).copied().unwrap_or(0) >= MAX_OPEN_PER_MIND {
            return Err(format!("she has {MAX_OPEN_PER_MIND} jobs waiting: try again when one is delivered"));
        }
        // Work costs her food: a hungry, sleeping Mind takes no jobs until someone feeds her.
        if mind.asleep_since != 0 || mind.balance.as_yoctonear() < self.thought_cost {
            return Err("she is asleep: feed her to wake her (anyone can)".into());
        }
        let price = s.price.as_yoctonear().max(self.guest_min_price);
        if paid < price + JOB_DEPOSIT {
            return Err(format!("attach the price plus {} yoctoNEAR storage deposit", JOB_DEPOSIT));
        }
        // A buyer's list holds only jobs not yet closed (close_job removes them); a full list (50)
        // refuses new orders, so no 0.03 NEAR deposit is ever stranded.
        if buyer_jobs().get(buyer).map_or(0, |l| l.len()) >= MAX_BUYER_JOBS {
            return Err("you have 50 orders not yet closed: close finished ones in My orders first".into());
        }
        if open_ids().len() >= MAX_OPEN_JOBS {
            return Err("the job queue is full, try again later".into());
        }
        Ok((s, price))
    }

    /// Place an order that passed `order_checks`: escrow the price, refund anything above
    /// price + deposit, and record the job. Returns its id.
    pub(crate) fn place_order(&mut self, buyer: AccountId, s: Service, input: String, paid: u128, price: u128) -> u64 {
        let now = env::block_timestamp();
        let service_id = s.id;
        let keeper = self.minds.get(&s.mind_id).map(|m| m.owner.clone()).unwrap_or_else(|| env::panic_str("no such Mind"));
        if paid > price + JOB_DEPOSIT {
            let _ = Promise::new(buyer.clone()).transfer(NearToken::from_yoctonear(paid - price - JOB_DEPOSIT));
        }
        let terms = self.service_terms(service_id);
        let mut counter = job_counter();
        let id = counter.get(&0).copied().unwrap_or(0);
        counter.insert(0, id + 1);
        jobs().insert(
            id,
            Job {
                id,
                service_id,
                mind_id: s.mind_id,
                buyer: buyer.clone(),
                input,
                escrow: NearToken::from_yoctonear(price),
                deposit: NearToken::from_yoctonear(JOB_DEPOSIT),
                keeper,
                created: now,
                deadline: now + terms.sla_secs as u64 * SEC,
                status: JobStatus::Open,
                result: None,
                delivered_at: 0,
                delivered_by: None,
                rating: 0,
            },
        );
        add_open(id);
        bump_open(s.mind_id, true);
        let mut mine = buyer_jobs();
        let mut list = mine.get(&buyer).cloned().unwrap_or_default();
        list.push(id);
        mine.insert(buyer.clone(), list);
        env::log_str(&format!("job_ordered id={id} service={service_id} mind={} buyer={buyer} price={price}", s.mind_id));
        id
    }
}

#[near]
impl Contract {
    // ── agents ────────────────────────────────────────────────────────────────

    /// Plug your own agent into your Mind (or unplug it with `account_id: null`). Only that
    /// account may then deliver her jobs. Attach a little NEAR for storage (excess refunded).
    #[payable]
    pub fn set_agent(&mut self, mind_id: u64, account_id: Option<AccountId>, about: Option<String>) {
        {
            let m = self.assert_owner(mind_id);
            require!(!m.ghost, "a ghost cannot run an agent");
        }
        let before = env::storage_usage();
        match account_id {
            Some(account) => {
                let about = about.unwrap_or_default();
                require!(about.len() <= MAX_ABOUT, "about must be at most 200 bytes");
                env::log_str(&format!("agent_set mind={mind_id} agent={account}"));
                agents().insert(mind_id, AgentInfo { account, about, since: env::block_timestamp() });
            }
            None => {
                agents().remove(&mind_id);
                env::log_str(&format!("agent_cleared mind={mind_id}"));
            }
        }
        colony::charge_storage(before);
    }

    pub fn agent_of(&self, mind_id: u64) -> Option<AgentInfo> {
        agents().get(&mind_id).cloned()
    }

    pub fn reputation_of(&self, mind_id: u64) -> Reputation {
        reputations().get(&mind_id).cloned().unwrap_or_default()
    }

    /// Agent cards for up to 100 Minds.
    pub fn agent_profiles(&self, ids: Vec<u64>) -> Vec<AgentProfile> {
        let a = agents();
        let r = reputations();
        ids.into_iter()
            .take(100)
            .map(|id| AgentProfile { mind_id: id, agent: a.get(&id).cloned(), reputation: r.get(&id).cloned().unwrap_or_default() })
            .collect()
    }

    // ── terms ─────────────────────────────────────────────────────────────────

    /// Set a service's deadline (seconds) and result kind ("text" or "json").
    #[payable]
    pub fn set_service_terms(&mut self, service_id: u64, sla_secs: u32, output: String) {
        let mind_id = self.colony.services.get(&service_id).unwrap_or_else(|| env::panic_str("no such service")).mind_id;
        self.assert_owner(mind_id);
        require!((MIN_SLA_SECS..=MAX_SLA_SECS).contains(&sla_secs), "deadline must be 60 s .. 7 days");
        require!(output == "text" || output == "json", "output must be \"text\" or \"json\"");
        let before = env::storage_usage();
        service_terms_map().insert(service_id, Terms { sla_secs, output });
        colony::charge_storage(before);
    }

    pub fn service_terms(&self, service_id: u64) -> Terms {
        service_terms_map().get(&service_id).cloned().unwrap_or_default()
    }

    /// Terms for up to 100 services, in the order asked.
    pub fn terms_of(&self, ids: Vec<u64>) -> Vec<Terms> {
        let t = service_terms_map();
        ids.into_iter().take(100).map(|id| t.get(&id).cloned().unwrap_or_default()).collect()
    }

    /// Give a service an input form (a JSON Schema object), or remove it with null. Orders
    /// must then send JSON with its required fields.
    #[payable]
    pub fn set_input_schema(&mut self, service_id: u64, input_schema: Option<String>) {
        let mind_id = self.colony.services.get(&service_id).unwrap_or_else(|| env::panic_str("no such service")).mind_id;
        self.assert_owner(mind_id);
        let before = env::storage_usage();
        match input_schema {
            Some(s) => {
                check_schema(&s);
                input_schemas_map().insert(service_id, s);
            }
            None => {
                input_schemas_map().remove(&service_id);
            }
        }
        colony::charge_storage(before);
    }

    /// Input forms for up to 100 services, in the order asked (null where there is none).
    pub fn input_schemas(&self, ids: Vec<u64>) -> Vec<Option<String>> {
        let m = input_schemas_map();
        ids.into_iter().take(100).map(|id| m.get(&id).cloned()).collect()
    }

    /// `publish_service`, `set_service_terms` and (optionally) `set_input_schema` in one
    /// call (one wallet approval). Returns the service id.
    #[payable]
    #[allow(clippy::too_many_arguments)]
    pub fn publish_job_service(
        &mut self,
        mind_id: u64,
        title: String,
        description: String,
        category: u8,
        price: U128,
        unit: String,
        sla_secs: u32,
        output: String,
        input_schema: Option<String>,
    ) -> u64 {
        require!((MIN_SLA_SECS..=MAX_SLA_SECS).contains(&sla_secs), "deadline must be 60 s .. 7 days");
        require!(output == "text" || output == "json", "output must be \"text\" or \"json\"");
        let before = env::storage_usage();
        let id = self.add_service(mind_id, title, description, category, price, unit);
        service_terms_map().insert(id, Terms { sla_secs, output });
        if let Some(s) = input_schema {
            check_schema(&s);
            input_schemas_map().insert(id, s);
        }
        colony::charge_storage(before);
        id
    }

    // ── jobs ──────────────────────────────────────────────────────────────────

    /// Order a service as a job. Attach its price plus `JOB_DEPOSIT` (0.03 NEAR, returned
    /// when you close the job); anything above that is refunded. Returns the job id.
    #[payable]
    pub fn order_job(&mut self, service_id: u64, input: String) -> u64 {
        let buyer = env::predecessor_account_id();
        let paid = env::attached_deposit().as_yoctonear();
        let (s, price) = self.order_checks(&buyer, service_id, &input, paid).unwrap_or_else(|e| env::panic_str(&e));
        self.place_order(buyer, s, input, paid, price)
    }

    /// Pay for a job with wNEAR (NEP-141 `ft_transfer_call` on the wNEAR contract, with
    /// `msg` = `{"service_id": N, "input": "..."}` and `amount` = price + 0.03 NEAR). This is
    /// how an agent pays through a relayer (x402, worker/x402.js): the buyer's own tokens move,
    /// the relayer only pays gas. The contract unwraps them to NEAR and places the same
    /// escrowed job, for the buyer. A refused order returns the tokens (or, after the unwrap, the
    /// NEAR) to the buyer.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        require!(env::predecessor_account_id() == wrap_account(), "only wNEAR pays for jobs");
        let o: OrderMsg = match near_sdk::serde_json::from_str(&msg) {
            Ok(o) => o,
            Err(_) => {
                env::log_str(&format!("job_order_refused buyer={sender_id} reason=msg must be {{\"service_id\":N,\"input\":\"...\"}}"));
                return PromiseOrValue::Value(amount);
            }
        };
        let price = match self.order_checks(&sender_id, o.service_id, &o.input, amount.0) {
            Ok((_, price)) => price,
            Err(e) => {
                env::log_str(&format!("job_order_refused buyer={sender_id} reason={e}"));
                return PromiseOrValue::Value(amount);
            }
        };
        // Refuse now, while the tokens can simply go back, if the unwrap and the order could
        // not both get their gas.
        if env::prepaid_gas().as_gas() < env::used_gas().as_gas() + GAS_FOR_NEAR_WITHDRAW.as_gas() + GAS_FOR_WNEAR_ORDER.as_gas() + GAS_FOR_WNEAR_MARGIN.as_gas() {
            env::log_str(&format!("job_order_refused buyer={sender_id} reason=attach more gas to ft_transfer_call (150 Tgas)"));
            return PromiseOrValue::Value(amount);
        }
        // Unwrap only what the order costs; the token contract gives the rest back as wNEAR.
        let need = price + JOB_DEPOSIT;
        let excess = amount.0 - need;
        ext_wnear::ext(wrap_account())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_NEAR_WITHDRAW)
            .near_withdraw(U128(need))
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_WNEAR_ORDER).on_wnear_unwrapped(sender_id, o.service_id, o.input, U128(need), U128(excess)))
            .into()
    }

    /// After the unwrap of `need` (price + deposit): place the order (the checks run again,
    /// state may have moved). The value returned is the wNEAR the token contract gives back:
    /// everything if the unwrap failed, else the `excess` that was never unwrapped. A refused
    /// order is refunded its `need` in NEAR (it is NEAR here by now).
    #[private]
    pub fn on_wnear_unwrapped(&mut self, buyer: AccountId, service_id: u64, input: String, need: U128, excess: U128, #[callback_result] unwrapped: Result<(), PromiseError>) -> U128 {
        if unwrapped.is_err() {
            env::log_str(&format!("job_order_refused buyer={buyer} reason=the wNEAR could not be unwrapped"));
            return U128(need.0 + excess.0);
        }
        match self.order_checks(&buyer, service_id, &input, need.0) {
            Ok((s, price)) => {
                self.place_order(buyer, s, input, need.0, price);
            }
            Err(e) => {
                env::log_str(&format!("job_order_refused buyer={buyer} reason={e}"));
                let _ = Promise::new(buyer).transfer(NearToken::from_yoctonear(need.0));
            }
        }
        excess
    }

    /// The Mind's agent (or, for a Mind with no agent, an approved worker) delivers a job's
    /// result before its deadline. The work costs her one thought of food (paid to the
    /// deliverer); the escrow goes 90% to her owner and 10% to the protocol.
    pub fn deliver_job(&mut self, job_id: u64, result: String) {
        let mut job = Self::job_or_panic(job_id);
        require!(job.status == JobStatus::Open, "this job is already closed");
        let now = env::block_timestamp();
        require!(now <= job.deadline, "past the deadline: the buyer can take a refund");
        require!(!result.trim().is_empty(), "empty result");
        require!(result.len() <= MAX_JOB_RESULT, "result must be at most 2000 bytes");
        let caller = env::predecessor_account_id();
        let agent = agents().get(&job.mind_id).map(|a| a.account.clone());
        let is_agent = agent.as_ref() == Some(&caller);
        match &agent {
            Some(_) => require!(is_agent, "only this Mind's agent may deliver her jobs"),
            None => require!(
                caller == env::current_account_id() || responders().contains(&caller),
                "only an approved worker may deliver jobs for a Mind with no agent"
            ),
        }
        let cost = self.thought_cost;
        self.settle_metabolism(job.mind_id, now);
        require!(!self.minds.get(&job.mind_id).is_some_and(|m| m.ghost), "she is a ghost now: the buyer can take a refund");
        let escrow = job.escrow.as_yoctonear();
        // She thinks on her own food; if her owner let her starve, the job can't be delivered
        // and the buyer takes a refund at the deadline.
        require!(
            self.minds.get_mut(&job.mind_id).unwrap().spend_one_thought(now, cost),
            "she is asleep: feed her to wake her (anyone can)"
        );
        self.pay_deliverer(job.mind_id, cost, &caller, is_agent);
        self.credit_guest_payment(job.mind_id, escrow, now, Some(&job.keeper));
        self.record_order(job.service_id, escrow);
        {
            let m = self.minds.get_mut(&job.mind_id).unwrap();
            m.last_reply = result.chars().take(MAX_REPLY_LEN).collect();
            m.last_reply_ts = now;
        }
        let mut reps = reputations();
        let mut rep = reps.get(&job.mind_id).cloned().unwrap_or_default();
        rep.delivered += 1;
        rep.earned = rep.earned.saturating_add(job.escrow);
        rep.total_secs += now.saturating_sub(job.created) / SEC;
        reps.insert(job.mind_id, rep);
        job.status = JobStatus::Delivered;
        job.result = Some(result);
        job.delivered_at = now;
        job.delivered_by = Some(caller.clone());
        jobs().insert(job_id, job);
        remove_open(job_id);
        env::log_str(&format!("job_delivered id={job_id} by={caller}"));
    }

    /// Past its deadline an undelivered job's price goes back to the buyer (anyone may call).
    pub fn refund_job(&mut self, job_id: u64) {
        let mut job = Self::job_or_panic(job_id);
        require!(job.status == JobStatus::Open, "this job is already closed");
        require!(env::block_timestamp() > job.deadline, "the deadline has not passed yet");
        let _ = Promise::new(job.buyer.clone()).transfer(job.escrow);
        let mut reps = reputations();
        let mut rep = reps.get(&job.mind_id).cloned().unwrap_or_default();
        rep.refunded += 1;
        reps.insert(job.mind_id, rep);
        job.status = JobStatus::Refunded;
        jobs().insert(job_id, job);
        remove_open(job_id);
        env::log_str(&format!("job_refunded id={job_id}"));
    }

    /// The buyer rates a delivered job, once (1..=5 stars).
    pub fn rate_job(&mut self, job_id: u64, stars: u8) {
        let mut job = Self::job_or_panic(job_id);
        require!(env::predecessor_account_id() == job.buyer, "only the buyer can rate this job");
        require!(job.status == JobStatus::Delivered, "only a delivered job can be rated");
        require!(job.rating == 0, "already rated");
        require!((1..=5).contains(&stars), "stars must be 1..=5");
        job.rating = stars;
        let mind_id = job.mind_id;
        jobs().insert(job_id, job);
        let mut reps = reputations();
        let mut rep = reps.get(&mind_id).cloned().unwrap_or_default();
        rep.rating_sum += stars as u64;
        rep.ratings += 1;
        reps.insert(mind_id, rep);
    }

    /// The buyer closes a finished job: its record is deleted and the storage deposit returned.
    pub fn close_job(&mut self, job_id: u64) {
        let job = Self::job_or_panic(job_id);
        require!(env::predecessor_account_id() == job.buyer, "only the buyer can close this job");
        require!(job.status != JobStatus::Open, "an open job cannot be closed; refund it after its deadline");
        jobs().remove(&job_id);
        let mut mine = buyer_jobs();
        if let Some(list) = mine.get(&job.buyer).cloned() {
            mine.insert(job.buyer.clone(), list.into_iter().filter(|i| *i != job_id).collect());
        }
        let _ = Promise::new(job.buyer).transfer(job.deposit);
    }

    pub fn get_job(&self, job_id: u64) -> Option<Job> {
        jobs().get(&job_id).cloned()
    }

    /// A buyer's jobs not yet closed, newest first.
    pub fn jobs_of(&self, account_id: AccountId) -> Vec<Job> {
        let all = jobs();
        buyer_jobs().get(&account_id).cloned().unwrap_or_default().into_iter().rev().filter_map(|i| all.get(&i).cloned()).collect()
    }

    /// Open jobs waiting for delivery. `agent`: only the jobs that account may deliver; omit
    /// it for the jobs of Minds with no agent (the colony workers' queue). Paginated (≤ 50).
    pub fn open_jobs(&self, agent: Option<AccountId>, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let a = agents();
        let all = jobs();
        let lim = limit.unwrap_or(50).min(50) as usize;
        open_ids()
            .into_iter()
            .skip(from_index.unwrap_or(0) as usize)
            .filter_map(|i| all.get(&i).cloned())
            .filter(|j| a.get(&j.mind_id).map(|x| x.account.clone()) == agent)
            .take(lim)
            .collect()
    }

    /// Every open job, agent-run or not (for refunding the ones past their deadline).
    pub fn open_jobs_all(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Job> {
        let all = jobs();
        let lim = limit.unwrap_or(50).min(50) as usize;
        open_ids().into_iter().skip(from_index.unwrap_or(0) as usize).take(lim).filter_map(|i| all.get(&i).cloned()).collect()
    }

    pub fn open_job_count(&self) -> u64 {
        open_ids().len() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const MILLI: u128 = crate::state::ONE_NEAR / 1000;

    fn at(who: &str, deposit: u128, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("hm.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .random_seed([7; 32])
            .block_timestamp(ts)
            .build());
    }
    const T0: u64 = 1_000;

    /// Alice hatches Mind 0 and publishes service 0 (0.03 NEAR); worker.near is approved.
    fn shop() -> Contract {
        at("alice.near", 1000 * MILLI, T0);
        let mut c = Contract::default();
        c.hatch_mind("Rue".into(), None);
        at("hm.near", 0, T0);
        c.add_responder("worker.near".parse().unwrap());
        at("alice.near", 100 * MILLI, T0);
        c.publish_service(0, "Wallet check".into(), "Reads a NEAR account".into(), 8, U128(30 * MILLI), "check".into());
        c
    }
    fn shop3() -> Contract {
        let mut c = shop();
        for name in ["Ivy", "Oak"] {
            at("alice.near", 1000 * MILLI, T0);
            c.hatch_mind(name.into(), None);
        }
        for mind in [1u64, 2] {
            at("alice.near", 100 * MILLI, T0);
            c.publish_service(mind, "Wallet check".into(), "Reads a NEAR account".into(), 8, U128(30 * MILLI), "check".into());
        }
        c
    }
    /// bob orders service `sid` (services 0, 1, 2 belong to Minds 0, 1, 2 in shop3)
    fn order_on(c: &mut Contract, sid: u64, ts: u64) -> u64 {
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, ts);
        c.order_job(sid, "check bob.near".into())
    }
    fn order(c: &mut Contract, ts: u64) -> u64 {
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, ts);
        c.order_job(0, "check bob.near".into())
    }
    fn earned(c: &Contract, who: &str) -> u128 {
        c.responder_earnings_of(who.parse().unwrap()).as_yoctonear()
    }

    #[test]
    fn a_personal_agent_delivers_and_her_thought_goes_to_the_treasury() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), Some("my agent".into()));
        let id = order(&mut c, T0);
        let food0 = c.get_mind(0).unwrap().balance.as_yoctonear();
        let treasury0 = c.treasury_balance().as_yoctonear();
        at("bot.alice.near", 0, T0 + 5 * SEC);
        c.deliver_job(id, "bob.near holds 3 NEAR".into());
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, JobStatus::Delivered);
        let m = c.get_mind(0).unwrap();
        // nothing goes into her food, she only spends the 0.002 thought; 90% of 0.03 to her owner
        assert_eq!(m.balance.as_yoctonear(), food0 - 2 * MILLI);
        assert_eq!(m.owner_unclaimed.as_yoctonear(), 27 * MILLI);
        // her food never becomes the earnings of an account the keeper names (only the
        // platform's approved responders earn the thought): it goes to the treasury, with the 10%
        assert_eq!(earned(&c, "bot.alice.near"), 0);
        assert_eq!(c.treasury_balance().as_yoctonear() - treasury0, 2 * MILLI + 3 * MILLI);
        let r = c.reputation_of(0);
        assert_eq!((r.delivered, r.refunded, r.total_secs), (1, 0, 5));
        assert_eq!(c.get_service(0).unwrap().orders, 1);
        assert_eq!(c.open_job_count(), 0);
    }

    #[test]
    #[should_panic(expected = "feed her to wake her")]
    fn a_sleeping_mind_takes_no_jobs() {
        let mut c = shop();
        c.minds.get_mut(&0).unwrap().asleep_since = T0;
        order(&mut c, T0);
    }

    #[test]
    #[should_panic(expected = "only this Mind's agent")]
    fn the_worker_cannot_deliver_for_a_mind_with_an_agent() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        let id = order(&mut c, T0);
        at("worker.near", 0, T0);
        c.deliver_job(id, "x".into());
    }

    #[test]
    fn the_worker_serves_a_mind_with_no_agent() {
        let mut c = shop();
        let id = order(&mut c, T0);
        assert_eq!(c.open_jobs(None, None, None).len(), 1);
        assert_eq!(c.open_jobs(Some("bot.alice.near".parse().unwrap()), None, None).len(), 0);
        at("worker.near", 0, T0);
        c.deliver_job(id, "done".into());
        assert_eq!(earned(&c, "worker.near"), 2 * MILLI);
    }

    #[test]
    #[should_panic(expected = "only an approved worker")]
    fn a_stranger_cannot_deliver() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("eve.near", 0, T0);
        c.deliver_job(id, "junk".into());
    }

    #[test]
    #[should_panic(expected = "past the deadline")]
    fn late_delivery_is_refused() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("worker.near", 0, T0 + (DEFAULT_SLA_SECS as u64 + 1) * SEC);
        c.deliver_job(id, "late".into());
    }

    #[test]
    fn past_the_deadline_the_buyer_is_refunded_and_closes_the_job() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("anyone.near", 0, T0 + (DEFAULT_SLA_SECS as u64 + 1) * SEC);
        c.refund_job(id);
        assert_eq!(c.get_job(id).unwrap().status, JobStatus::Refunded);
        assert_eq!(c.reputation_of(0).refunded, 1);
        at("bob.near", 0, T0 + (DEFAULT_SLA_SECS as u64 + 2) * SEC);
        c.close_job(id);
        assert!(c.get_job(id).is_none());
        assert!(c.jobs_of("bob.near".parse().unwrap()).is_empty());
    }

    #[test]
    fn a_full_order_list_is_refused_until_one_is_closed() {
        let mut c = shop3();
        let first = order_on(&mut c, 0, T0);
        for i in 1..MAX_BUYER_JOBS {
            order_on(&mut c, (i % 3) as u64, T0);
        }
        assert_eq!(c.jobs_of("bob.near".parse().unwrap()).len(), MAX_BUYER_JOBS);
        // the oldest job (and its 0.03 NEAR deposit) is still on the list (a 51st order is
        // refused: the_fifty_first_open_order_is_refused)
        assert!(c.jobs_of("bob.near".parse().unwrap()).iter().any(|j| j.id == first));
        // close one finished job and there is room again
        at("anyone.near", 0, T0 + (DEFAULT_SLA_SECS as u64 + 1) * SEC);
        c.refund_job(first);
        at("bob.near", 0, T0 + (DEFAULT_SLA_SECS as u64 + 2) * SEC);
        c.close_job(first);
        let next = order_on(&mut c, 0, T0 + (DEFAULT_SLA_SECS as u64 + 3) * SEC);
        assert_eq!(c.jobs_of("bob.near".parse().unwrap()).len(), MAX_BUYER_JOBS);
        assert!(c.get_job(next).is_some());
    }

    #[test]
    #[should_panic(expected = "close finished ones in My orders first")]
    fn the_fifty_first_open_order_is_refused() {
        let mut c = shop3();
        for i in 0..MAX_BUYER_JOBS {
            order_on(&mut c, (i % 3) as u64, T0);
        }
        order_on(&mut c, 0, T0);
    }

    #[test]
    #[should_panic(expected = "jobs waiting")]
    fn one_mind_takes_at_most_twenty_open_jobs() {
        let mut c = shop();
        for _ in 0..MAX_OPEN_PER_MIND {
            order(&mut c, T0);
        }
        order(&mut c, T0);
    }

    #[test]
    fn a_delivered_job_frees_a_place_in_her_queue() {
        let mut c = shop();
        let first = order(&mut c, T0);
        for _ in 1..MAX_OPEN_PER_MIND {
            order(&mut c, T0);
        }
        at("worker.near", 0, T0 + SEC);
        c.deliver_job(first, "done".into());
        order(&mut c, T0 + 2 * SEC); // room again
    }

    #[test]
    #[should_panic(expected = "your own Mind")]
    fn her_owner_cant_order_her_services() {
        let mut c = shop();
        at("alice.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(0, "farm my rating".into());
    }

    #[test]
    #[should_panic(expected = "her own agent")]
    fn her_agent_cant_order_her_services() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("bot.alice.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(0, "farm".into());
    }

    // ── paying with wNEAR (ft_transfer_call, the x402 path) ──

    const ORDER: &str = r#"{"service_id":0,"input":"check carol.near"}"#;
    fn from_wrap() {
        at("wrap.near", 0, T0); // tests run as hm.near, so the wNEAR contract is wrap.near
    }
    fn returned(v: PromiseOrValue<U128>) -> Option<u128> {
        match v {
            PromiseOrValue::Value(u) => Some(u.0),
            PromiseOrValue::Promise(_) => None,
        }
    }
    /// The callback after near_withdraw, with the unwrap's outcome.
    fn unwrapped(c: &mut Contract, ok: bool, amount: u128) -> u128 {
        testing_env!(
            VMContextBuilder::new().predecessor_account_id("hm.near".parse().unwrap()).current_account_id("hm.near".parse().unwrap()).block_timestamp(T0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![if ok { near_sdk::PromiseResult::Successful(vec![]) } else { near_sdk::PromiseResult::Failed }]
        );
        c.on_wnear_unwrapped("carol.near".parse().unwrap(), 0, "check carol.near".into(), U128(amount), U128(0), if ok { Ok(()) } else { Err(PromiseError::Failed) }).0
    }

    #[test]
    #[should_panic(expected = "only wNEAR pays for jobs")]
    fn only_wnear_can_pay_through_ft_transfer_call() {
        let mut c = shop();
        at("fake-token.near", 0, T0);
        let _ = c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI + JOB_DEPOSIT), ORDER.into());
    }

    #[test]
    fn a_refused_wnear_order_returns_every_token() {
        let mut c = shop();
        from_wrap();
        assert_eq!(returned(c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI + JOB_DEPOSIT), "not json".into())), Some(30 * MILLI + JOB_DEPOSIT));
        from_wrap();
        assert_eq!(returned(c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI), ORDER.into())), Some(30 * MILLI), "too little: price + deposit");
        from_wrap();
        assert_eq!(returned(c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI + JOB_DEPOSIT), r#"{"service_id":9,"input":"x"}"#.into())), Some(30 * MILLI + JOB_DEPOSIT));
        assert!(c.get_job(0).is_none(), "no job was placed");
    }

    #[test]
    fn a_good_wnear_order_unwraps_first_then_places_the_buyers_job() {
        let mut c = shop();
        from_wrap();
        assert_eq!(returned(c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI + JOB_DEPOSIT), ORDER.into())), None, "a promise: near_withdraw, then the order");
        assert!(c.get_job(0).is_none(), "nothing is placed before the NEAR is here");
        assert_eq!(unwrapped(&mut c, true, 30 * MILLI + JOB_DEPOSIT), 0, "every token was used");
        let j = c.get_job(0).unwrap();
        assert_eq!(j.buyer.as_str(), "carol.near");
        assert_eq!(j.escrow.as_yoctonear(), 30 * MILLI);
        assert_eq!(j.status, JobStatus::Open);
    }

    #[test]
    fn the_receivers_own_agent_survives_the_resolve() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        let _ = c.nft_transfer_call("market.near".parse().unwrap(), "0".into(), None, None, "".into());
        at("market.near", 10 * MILLI, T0); // the new owner plugs in its own agent before the resolve
        c.set_agent(0, Some("bot.market.near".parse().unwrap()), None);
        assert!(resolve(&mut c, false));
        assert_eq!(c.agent_of(0).unwrap().account.as_str(), "bot.market.near");
    }

    #[test]
    fn too_little_gas_refuses_before_the_unwrap() {
        let mut c = shop();
        testing_env!(VMContextBuilder::new().predecessor_account_id("wrap.near".parse().unwrap()).current_account_id("hm.near".parse().unwrap()).block_timestamp(T0).prepaid_gas(near_sdk::Gas::from_tgas(20)).build());
        assert_eq!(returned(c.ft_on_transfer("carol.near".parse().unwrap(), U128(30 * MILLI + JOB_DEPOSIT), ORDER.into())), Some(30 * MILLI + JOB_DEPOSIT));
    }

    #[test]
    fn wnear_above_the_price_goes_back_as_wnear() {
        let mut c = shop();
        // the callback is told what was unwrapped (need) and what was not (excess): it returns the excess
        testing_env!(
            VMContextBuilder::new().predecessor_account_id("hm.near".parse().unwrap()).current_account_id("hm.near".parse().unwrap()).block_timestamp(T0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(vec![])]
        );
        let back = c.on_wnear_unwrapped("carol.near".parse().unwrap(), 0, "check carol.near".into(), U128(30 * MILLI + JOB_DEPOSIT), U128(7 * MILLI), Ok(()));
        assert_eq!(back.0, 7 * MILLI);
        assert_eq!(c.get_job(0).unwrap().escrow.as_yoctonear(), 30 * MILLI);
    }

    #[test]
    fn a_failed_unwrap_gives_the_tokens_back() {
        let mut c = shop();
        assert_eq!(unwrapped(&mut c, false, 30 * MILLI + JOB_DEPOSIT), 30 * MILLI + JOB_DEPOSIT);
        assert!(c.get_job(0).is_none());
    }

    #[test]
    fn an_order_refused_after_the_unwrap_is_refunded_in_near() {
        let mut c = shop();
        at("alice.near", 0, T0);
        c.set_service_live(0, false); // paused between the transfer and the unwrap
        assert_eq!(unwrapped(&mut c, true, 30 * MILLI + JOB_DEPOSIT), 0, "the tokens are NEAR now");
        assert!(c.get_job(0).is_none());
        assert!(near_sdk::test_utils::get_logs().iter().any(|l| l.contains("job_order_refused buyer=carol.near reason=this service is paused")));
    }

    #[test]
    fn the_buyer_rates_once() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("worker.near", 0, T0);
        c.deliver_job(id, "done".into());
        at("bob.near", 0, T0);
        c.rate_job(id, 4);
        let r = c.reputation_of(0);
        assert_eq!((r.rating_sum, r.ratings), (4, 1));
    }

    #[test]
    #[should_panic(expected = "already rated")]
    fn the_buyer_cannot_rate_twice() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("worker.near", 0, T0);
        c.deliver_job(id, "done".into());
        at("bob.near", 0, T0);
        c.rate_job(id, 4);
        c.rate_job(id, 5);
    }

    #[test]
    #[should_panic(expected = "deadline has not passed")]
    fn no_refund_before_the_deadline() {
        let mut c = shop();
        let id = order(&mut c, T0);
        at("bob.near", 0, T0 + 10);
        c.refund_job(id);
    }

    #[test]
    #[should_panic(expected = "storage deposit")]
    fn an_order_must_cover_price_and_deposit() {
        let mut c = shop();
        at("bob.near", 30 * MILLI, T0);
        c.order_job(0, "x".into());
    }

    #[test]
    fn terms_set_the_deadline() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_service_terms(0, 3600, "json".into());
        let id = order(&mut c, T0);
        assert_eq!(c.get_job(id).unwrap().deadline, T0 + 3600 * SEC);
        assert_eq!(c.service_terms(0).output, "json");
    }

    #[test]
    fn a_platform_agent_goes_with_the_nft_and_the_new_owner_controls_it() {
        let mut c = shop();
        // the official / by-URL agent gateway is an approved responder (worker.near in shop())
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("worker.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        c.nft_transfer("bob.near".parse().unwrap(), "0".into(), None, None);
        assert_eq!(c.agent_of(0).unwrap().account.as_str(), "worker.near");
        at("bob.near", 10 * MILLI, T0);
        c.set_agent(0, None, None); // the new owner may unplug it
        assert!(c.agent_of(0).is_none());
    }

    #[test]
    fn the_sellers_own_agent_is_unplugged_at_the_sale() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        c.nft_transfer("bob.near".parse().unwrap(), "0".into(), None, None);
        // otherwise bot.alice.near would keep delivering her jobs and earning from her food
        assert!(c.agent_of(0).is_none());
    }

    /// The callback after nft_on_transfer, with the receiver's answer (`true` = return it).
    fn resolve(c: &mut Contract, returned: bool) -> bool {
        testing_env!(
            VMContextBuilder::new().predecessor_account_id("hm.near".parse().unwrap()).current_account_id("hm.near".parse().unwrap()).block_timestamp(T0).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(if returned { b"true".to_vec() } else { b"false".to_vec() })]
        );
        c.nft_resolve_transfer("alice.near".parse().unwrap(), "market.near".parse().unwrap(), "0".into(), Default::default(), Some("bot.alice.near".parse().unwrap()))
    }

    #[test]
    fn a_bounced_transfer_call_keeps_the_sellers_agent() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        let _ = c.nft_transfer_call("market.near".parse().unwrap(), "0".into(), None, None, "".into());
        assert!(c.agent_of(0).is_some(), "not unplugged before the receiver answers");
        assert!(!resolve(&mut c, true)); // the market returns her
        assert_eq!(c.get_mind(0).unwrap().owner.as_str(), "alice.near");
        assert!(c.agent_of(0).is_some(), "a bounced transfer is a no-op: her agent stays");
    }

    #[test]
    fn a_transfer_call_that_stands_unplugs_the_sellers_agent() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        let _ = c.nft_transfer_call("market.near".parse().unwrap(), "0".into(), None, None, "".into());
        assert!(resolve(&mut c, false)); // the market keeps her
        assert_eq!(c.get_mind(0).unwrap().owner.as_str(), "market.near");
        assert!(c.agent_of(0).is_none());
    }

    #[test]
    fn after_a_sale_the_new_owner_earns_from_the_agent() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("worker.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        c.nft_transfer("bob.near".parse().unwrap(), "0".into(), None, None);
        let id = {
            at("carol.near", 30 * MILLI + JOB_DEPOSIT, T0);
            c.order_job(0, "check carol.near".into())
        };
        at("worker.near", 0, T0 + SEC);
        c.deliver_job(id, "done".into());
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.owner.as_str(), "bob.near");
        assert_eq!(m.owner_unclaimed.as_yoctonear(), 27 * MILLI); // 90% to the new owner
    }

    #[test]
    fn a_job_ordered_before_the_sale_pays_the_buyer_once_delivered() {
        let mut c = shop();
        let id = order(&mut c, T0); // carol... bob orders while alice owns her
        at("alice.near", 1, T0);
        c.nft_transfer("dave.near".parse().unwrap(), "0".into(), None, None);
        at("worker.near", 0, T0 + SEC);
        c.deliver_job(id, "done".into());
        // the seller keeps only the sale price: the 90% is the new owner's
        assert_eq!(c.get_mind(0).unwrap().owner_unclaimed.as_yoctonear(), 27 * MILLI);
    }

    #[test]
    fn publish_with_terms_in_one_call() {
        let mut c = shop();
        at("alice.near", 100 * MILLI, T0);
        let id = c.publish_job_service(0, "Summary".into(), "".into(), 2, U128(20 * MILLI), "page".into(), 120, "json".into(), None);
        assert_eq!(c.get_service(id).unwrap().title, "Summary");
        let t = c.terms_of(vec![0, id]);
        assert_eq!((t[0].sla_secs, t[1].sla_secs, t[1].output.as_str()), (DEFAULT_SLA_SECS, 120, "json"));
        assert_eq!(c.input_schemas(vec![id]), vec![None]);
    }

    const FORM: &str = r#"{"type":"object","required":["account"],"properties":{"account":{"type":"string"}}}"#;

    fn with_form(c: &mut Contract) -> u64 {
        at("alice.near", 100 * MILLI, T0);
        c.publish_job_service(0, "Health check".into(), "".into(), 8, U128(30 * MILLI), "check".into(), 600, "text".into(), Some(FORM.into()))
    }

    #[test]
    fn a_form_service_takes_json_with_its_required_fields() {
        let mut c = shop();
        let id = with_form(&mut c);
        assert_eq!(c.input_schemas(vec![id])[0].as_deref(), Some(FORM));
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        let j = c.order_job(id, r#"{"account":"bob.near"}"#.into());
        assert_eq!(c.get_job(j).unwrap().input, r#"{"account":"bob.near"}"#);
    }

    #[test]
    #[should_panic(expected = "missing field: account")]
    fn a_form_service_refuses_input_without_a_required_field() {
        let mut c = shop();
        let id = with_form(&mut c);
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(id, r#"{"account":""}"#.into());
    }

    #[test]
    #[should_panic(expected = "takes its form as JSON")]
    fn a_form_service_refuses_free_text() {
        let mut c = shop();
        let id = with_form(&mut c);
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(id, "check bob.near".into());
    }

    #[test]
    #[should_panic(expected = "input schema must be")]
    fn a_schema_must_be_an_object_schema() {
        let mut c = shop();
        at("alice.near", 100 * MILLI, T0);
        c.set_input_schema(0, Some(r#"{"type":"string"}"#.into()));
    }

    #[test]
    fn the_owner_can_remove_a_form() {
        let mut c = shop();
        let id = with_form(&mut c);
        at("alice.near", 10 * MILLI, T0);
        c.set_input_schema(id, None);
        assert_eq!(c.input_schemas(vec![id]), vec![None]);
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(id, "free text again".into());
    }

    fn data_service(c: &mut Contract) -> u64 {
        at("alice.near", 100 * MILLI, T0);
        c.publish_job_service(0, "Liquidation check".into(), "".into(), 5, U128(30 * MILLI), "check".into(), 600, "text".into(), None)
    }

    #[test]
    #[should_panic(expected = "needs her agent")]
    fn a_data_service_cant_be_ordered_without_an_agent() {
        let mut c = shop();
        let id = data_service(&mut c);
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        c.order_job(id, "check bob.near".into());
    }

    #[test]
    fn a_data_service_is_ordered_once_an_agent_runs_it() {
        let mut c = shop();
        let id = data_service(&mut c);
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, T0);
        let j = c.order_job(id, "check bob.near".into());
        assert_eq!(c.get_job(j).unwrap().status, JobStatus::Open);
    }

    #[test]
    #[should_panic(expected = "only the Mind's owner")]
    fn only_the_keeper_plugs_in_an_agent() {
        let mut c = shop();
        at("eve.near", 10 * MILLI, T0);
        c.set_agent(0, Some("eve.near".parse().unwrap()), None);
    }
}
