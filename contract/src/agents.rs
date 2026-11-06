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
/// How many of a buyer's jobs are remembered for "My orders" (oldest drop off the list).
const MAX_BUYER_JOBS: usize = 50;
const SEC: u64 = 1_000_000_000;
/// Jobs that may wait for delivery at once (bounds the open list a view or call reads).
const MAX_OPEN_JOBS: usize = 1_000;

fn agents() -> LookupMap<u64, AgentInfo> {
    LookupMap::new(b"a".to_vec())
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
fn remove_open(id: u64) {
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
    /// Who kept the Mind when the job was paid: the 20% is theirs even if she changes hands.
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
    fn pay_deliverer(&mut self, mind_id: u64, cost: u128, deliverer: &AccountId, is_agent: bool) {
        let owner = self.minds.get(&mind_id).map(|m| m.owner.clone());
        if is_agent && Some(deliverer) != owner.as_ref() {
            let mut earned = responder_earnings();
            let prev = earned.get(deliverer).copied().unwrap_or(0);
            earned.insert(deliverer.clone(), prev.saturating_add(cost));
        } else {
            self.pay_for_thought(mind_id, cost, Some(deliverer.clone()));
        }
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
        let s = self.colony.services.get(&service_id).unwrap_or_else(|| env::panic_str("no such service")).clone();
        require!(s.live, "this service is paused");
        require!(!needs_agent(s.category) || has_agent(s.mind_id), "this service needs her agent, and none is plugged in right now");
        require!(input.len() <= MAX_JOB_INPUT, "input must be at most 1000 bytes");
        if let Some(schema) = input_schemas_map().get(&service_id) {
            // A service with a form takes JSON with the form's required fields.
            let v: near_sdk::serde_json::Value = near_sdk::serde_json::from_str(&input).unwrap_or_else(|_| env::panic_str("this service takes its form as JSON input"));
            for field in check_schema(schema) {
                require!(v.get(&field).is_some_and(|x| !x.is_null() && x.as_str() != Some("")), format!("missing field: {field}"));
            }
        }
        let now = env::block_timestamp();
        self.settle_metabolism(s.mind_id, now);
        let mind = self.minds.get(&s.mind_id).unwrap_or_else(|| env::panic_str("no such Mind"));
        require!(!mind.ghost, "a ghost takes no jobs");
        // Work costs her food, and only her owner feeds her: a hungry, sleeping Mind takes no jobs.
        require!(mind.asleep_since == 0 && mind.balance.as_yoctonear() >= self.thought_cost, "she is asleep: her owner has to feed her first");
        let keeper = mind.owner.clone();
        let price = s.price.as_yoctonear().max(self.guest_min_price);
        let paid = env::attached_deposit().as_yoctonear();
        require!(paid >= price + JOB_DEPOSIT, format!("attach the price plus {} yoctoNEAR storage deposit", JOB_DEPOSIT));
        let buyer = env::predecessor_account_id();
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
        let mut mine = buyer_jobs();
        let mut list = mine.get(&buyer).cloned().unwrap_or_default();
        list.push(id);
        if list.len() > MAX_BUYER_JOBS {
            list.remove(0);
        }
        mine.insert(buyer.clone(), list);
        env::log_str(&format!("job_ordered id={id} service={service_id} mind={} buyer={buyer} price={price}", s.mind_id));
        id
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
            "she is asleep: her owner has to feed her first"
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

    /// A buyer's recent jobs, newest first.
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
    fn order(c: &mut Contract, ts: u64) -> u64 {
        at("bob.near", 30 * MILLI + JOB_DEPOSIT, ts);
        c.order_job(0, "check bob.near".into())
    }
    fn earned(c: &Contract, who: &str) -> u128 {
        c.responder_earnings_of(who.parse().unwrap()).as_yoctonear()
    }

    #[test]
    fn agent_delivers_and_gets_paid_the_thought() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), Some("my agent".into()));
        let id = order(&mut c, T0);
        let food0 = c.get_mind(0).unwrap().balance.as_yoctonear();
        at("bot.alice.near", 0, T0 + 5 * SEC);
        c.deliver_job(id, "bob.near holds 3 NEAR".into());
        let j = c.get_job(id).unwrap();
        assert_eq!(j.status, JobStatus::Delivered);
        let m = c.get_mind(0).unwrap();
        // nothing goes into her food, she only spends the 0.002 thought; 90% of 0.03 to her owner
        assert_eq!(m.balance.as_yoctonear(), food0 - 2 * MILLI);
        assert_eq!(m.owner_unclaimed.as_yoctonear(), 27 * MILLI);
        assert_eq!(earned(&c, "bot.alice.near"), 2 * MILLI);
        let r = c.reputation_of(0);
        assert_eq!((r.delivered, r.refunded, r.total_secs), (1, 0, 5));
        assert_eq!(c.get_service(0).unwrap().orders, 1);
        assert_eq!(c.open_job_count(), 0);
    }

    #[test]
    #[should_panic(expected = "her owner has to feed her first")]
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
    fn the_agent_goes_with_the_nft_and_the_new_owner_controls_it() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        c.nft_transfer("bob.near".parse().unwrap(), "0".into(), None, None);
        assert_eq!(c.agent_of(0).unwrap().account.as_str(), "bot.alice.near");
        at("bob.near", 10 * MILLI, T0);
        c.set_agent(0, None, None); // the new owner may unplug it
        assert!(c.agent_of(0).is_none());
    }

    #[test]
    fn after_a_sale_the_new_owner_earns_from_the_agent() {
        let mut c = shop();
        at("alice.near", 10 * MILLI, T0);
        c.set_agent(0, Some("bot.alice.near".parse().unwrap()), None);
        at("alice.near", 1, T0);
        c.nft_transfer("bob.near".parse().unwrap(), "0".into(), None, None);
        let id = {
            at("carol.near", 30 * MILLI + JOB_DEPOSIT, T0);
            c.order_job(0, "check carol.near".into())
        };
        at("bot.alice.near", 0, T0 + SEC);
        c.deliver_job(id, "done".into());
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.owner.as_str(), "bob.near");
        assert_eq!(m.owner_unclaimed.as_yoctonear(), 27 * MILLI); // 90% to the new owner
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
