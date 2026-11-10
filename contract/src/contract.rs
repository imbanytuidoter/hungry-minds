//! NEP-171 contract shell.
//!
//! State is deliberately tiny per Mind: traits + a few ints + short name.
//! Everything derived (hunger state, mood, the SVG) is computed from these in
//! views, and all money math goes through the pure `economy` module.

use crate::art::Appearance;
use crate::state::{hunger_state, HungerState};
use crate::{economy, traits};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError,
    PromiseOrValue, YieldId,
};
use std::collections::{BTreeMap, HashMap};

#[path = "colony.rs"]
mod colony;
pub use colony::{Listing, Look, Service, MAX_SUPPLY};

#[path = "chat.rs"]
mod chat;
pub use chat::{ChatUse, SettleReport};
#[path = "agents.rs"]
mod agents;
pub use agents::{AgentInfo, AgentProfile, Job, JobStatus, Reputation, Terms};

/// NEP-199: how the proceeds of a sale are split (account -> amount).
#[near(serializers = [json])]
pub struct Payout {
    pub payout: HashMap<AccountId, U128>,
}

/// Gas reserved for the thinking callback when the reply (or timeout) comes back.
const GAS_FOR_THINK_CALLBACK: Gas = Gas::from_tgas(10);
/// Longest prompt a Mind will accept — bounds request storage and abuse.
const MAX_PROMPT_LEN: usize = 500;
/// Longest reply stored on a Mind (bounds what a responder can make the contract store).
const MAX_REPLY_LEN: usize = 1000;

/// Accounts allowed to answer parked thoughts (`respond`), managed by the contract account.
/// Kept under its own storage prefix rather than as a field, so the contract's state layout
/// is unchanged.
fn responders() -> near_sdk::store::LookupSet<AccountId> {
    near_sdk::store::LookupSet::new(b"r".to_vec())
}

/// What each approved responder has earned answering thoughts (yoctoNEAR), withdrawn via
/// `claim_responder_earnings`. Own prefix, so the state layout is unchanged.
fn responder_earnings() -> near_sdk::store::LookupMap<AccountId, u128> {
    near_sdk::store::LookupMap::new(b"e".to_vec())
}

/// Who answered each parked thought (request id -> responder), read once it resolves.
fn answered_by() -> near_sdk::store::LookupMap<u64, AccountId> {
    near_sdk::store::LookupMap::new(b"w".to_vec())
}

/// Liquid balance a treasury withdrawal must leave on top of the contract's storage stake,
/// so a ghost's storage (whose 0.25 NEAR reserve went back to its owner) stays paid for.
const TREASURY_FLOAT: u128 = crate::state::ONE_NEAR;
const GAS_FOR_WITHDRAW_CALLBACK: Gas = Gas::from_tgas(5);

/// The receiver interface for `nft_transfer_call` (NEP-171 core).
#[allow(dead_code)] // the #[ext_contract] macro consumes this to generate ext_nft_receiver
#[ext_contract(ext_nft_receiver)]
trait NftReceiver {
    fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> PromiseOrValue<bool>;
}

const GAS_FOR_NFT_ON_TRANSFER: Gas = Gas::from_tgas(30);
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_NFT_APPROVE: Gas = Gas::from_tgas(10);

/// The receiver interface for `nft_approve` with a `msg` (NEP-178): the approved contract
/// (e.g. a marketplace) is notified so it can list the Mind.
#[allow(dead_code)] // the #[ext_contract] macro consumes this to generate ext_nft_approval_receiver
#[ext_contract(ext_nft_approval_receiver)]
trait NftApprovalReceiver {
    fn nft_on_approve(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        approval_id: u64,
        msg: String,
    );
}

/// Decide, from the receiver's `nft_on_transfer` outcome, whether to revert the transfer.
/// A successful call returning `true` — or any failure — means "return the token".
fn should_revert(result: Result<bool, ()>) -> bool {
    match result {
        Ok(wants_return) => wants_return,
        Err(()) => true,
    }
}

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
    /// Block timestamp metabolism was last settled against. Autonomous idle drain is charged
    /// from here forward; reset to `now` whenever the Mind wakes, so a sleep gap is never
    /// retroactively charged.
    pub last_metabolism_ts: u64,
    /// 0 = awake; otherwise the block timestamp it fell asleep.
    pub asleep_since: u64,
    pub thought_count: u64,
    pub ghost: bool,
    /// What the owner may claim: their 90% of guest chats, services and jobs, plus the hatch
    /// reserve rebate once the Mind is a ghost. Never the Mind's food.
    pub owner_unclaimed: NearToken,
    /// The Mind's most recent delivered thought (empty until it has thought once).
    pub last_reply: String,
    pub last_reply_ts: u64,
    /// NEP-178 approvals: who may transfer this Mind on the owner's behalf, each with its
    /// approval_id. Cleared on every transfer. BTreeMap for deterministic borsh.
    pub approvals: BTreeMap<AccountId, u64>,
    /// Next approval_id to hand out for this Mind (monotonic; starts at 1).
    pub next_approval_id: u64,
}

impl Mind {
    /// Charge the Mind for one thought. Returns true if it could think.
    /// A Mind that is a ghost, already asleep, or too poor to afford a reply
    /// cannot think; the moment it can no longer afford one it falls asleep
    /// (recording `now`, which starts the ghost clock).
    pub fn spend_one_thought(&mut self, now: u64, cost: u128) -> bool {
        if self.ghost || self.asleep_since != 0 {
            return false;
        }
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

/// A thought in flight: the contract parked a yielded promise and is waiting for the
/// off-chain worker (worker/index.js -> NEAR AI Cloud) to resume it with a reply.
#[near(serializers = [borsh])]
pub struct Pending {
    pub mind_id: u64,
    pub prompt: String,
    pub by_owner: bool,
    pub yield_id: YieldId,
    /// The thought cost locked in at spend time, so a timeout refunds exactly what the
    /// Mind paid even if the governable `thought_cost` was retuned while this was in flight.
    pub cost_paid: u128,
    /// Escrow for a guest thought: who paid and how much. The 90/10 owner/protocol split is applied only
    /// once a reply is delivered; on timeout the whole deposit goes back to the payer.
    pub payer: Option<AccountId>,
    pub escrow: u128,
    /// The service this thought was ordered through, if any (its stats update on delivery).
    pub service_id: Option<u64>,
    /// Who kept the Mind when the guest paid (a record only: the 90% goes to whoever owns her
    /// when the reply lands).
    pub keeper: Option<AccountId>,
}

/// A pending thought as the off-chain worker sees it (JSON view).
#[near(serializers = [json])]
pub struct PendingView {
    pub request_id: u64,
    pub mind_id: u64,
    pub prompt: String,
    pub by_owner: bool,
}

/// One row of the living-Minds leaderboard (JSON view).
#[near(serializers = [json])]
pub struct MindRank {
    pub id: u64,
    pub name: String,
    pub thoughts: u64,
    pub balance: NearToken,
    pub state: String,
}

/// The live, governable economy prices (JSON view) so the web app and off-chain worker read
/// the current numbers from chain instead of hardcoding them. `NearToken` serializes as a
/// yoctoNEAR string.
#[near(serializers = [json])]
pub struct EconomyParams {
    pub thought_cost: NearToken,
    pub guest_min_price: NearToken,
    pub revive_price: NearToken,
    pub mint_price: NearToken,
    pub idle_rate_per_day: u64,
}

#[near(contract_state)]
pub struct Contract {
    next_id: u64,
    treasury: NearToken,
    minds: IterableMap<u64, Mind>,
    /// Thoughts awaiting a reply, keyed by request id (the off-chain worker polls these).
    next_request: u64,
    pending: IterableMap<u64, Pending>,
    /// Governable economy prices (yoctoNEAR), seeded from `economy::*` defaults. Only the
    /// contract account itself (`predecessor == current_account_id`) may retune them via the
    /// `set_*` methods — the key that controls the contract account is the admin, so there is
    /// no separate owner field to initialize. `thought_cost` must track the real inference
    /// price, so it lives here, not frozen in code.
    thought_cost: u128,
    guest_min_price: u128,
    revive_price: u128,
    /// Autonomous metabolism rate: thoughts/day a neglected Mind burns from elapsed time alone.
    idle_rate_per_day: u64,
    /// Supply cap, cosmetic looks, services and the built-in sale market (colony.rs).
    colony: colony::Colony,
}

impl Default for Contract {
    fn default() -> Self {
        Self {
            next_id: 0,
            treasury: NearToken::from_yoctonear(0),
            minds: IterableMap::new(b"m"),
            next_request: 0,
            pending: IterableMap::new(b"p"),
            thought_cost: economy::THOUGHT_COMPUTE_COST,
            guest_min_price: economy::GUEST_PRICE,
            revive_price: economy::REVIVE_PRICE,
            idle_rate_per_day: crate::state::DEFAULT_IDLE_RATE,
            colony: colony::Colony::default(),
        }
    }
}

// Internal, promise-free helpers (unit-tested directly; the public methods below
// orchestrate these and the yield/resume to the worker).
impl Contract {
    /// Credit a delivered guest payment: 90% to the owner (unclaimed), 10% to the treasury.
    /// Nothing goes into the Mind's food; her owner feeds her. Called from escrow once the
    /// reply has landed, never at chat time.
    fn credit_guest_payment(&mut self, id: u64, deposit: u128, _now: u64, _keeper: Option<&AccountId>) {
        let split = economy::guest_split(deposit);
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
        let Some(mind) = self.minds.get_mut(&id) else {
            return;
        };
        // The owner's 90% always goes to whoever owns her when the work is delivered. A seller
        // keeps only the sale price (and what was already credited before the sale, paid out to
        // them by hand_over); nothing earned after the sale reaches them.
        mind.owner_unclaimed = mind
            .owner_unclaimed
            .saturating_add(NearToken::from_yoctonear(split.to_owner));
    }

    /// Resolve a parked thought by request id: store or refund it (finalize_thought), then
    /// settle any guest escrow — split on delivery, full refund to the payer on timeout.
    fn resolve_thought(&mut self, mind_id: u64, request_id: u64, outcome: Result<String, ()>, now: u64) {
        let removed = self.pending.remove(&request_id);
        let cost = removed.as_ref().map(|p| p.cost_paid).unwrap_or(self.thought_cost);
        let delivered = outcome.is_ok();
        self.finalize_thought(mind_id, outcome, now, cost);
        let responder = answered_by().remove(&request_id);
        let Some(p) = removed else { return };
        if delivered {
            self.pay_for_thought(mind_id, cost, responder);
        }
        let Some(payer) = p.payer else { return };
        if delivered {
            self.credit_guest_payment(mind_id, p.escrow, now, p.keeper.as_ref());
            if let Some(sid) = p.service_id {
                self.record_order(sid, p.escrow);
            }
        } else if p.escrow > 0 {
            let _ = Promise::new(payer).transfer(NearToken::from_yoctonear(p.escrow));
        }
    }

    /// Build the NEP-171 `Token` view for a Mind, with live on-chain SVG media.
    /// The glossy character the game shows, drawn on chain from the keeper's look (or, if
    /// none was chosen, from the trait dials) and the current life state.
    fn glossy_svg(&self, id: u64, mind: &Mind, frame: bool) -> String {
        let look = match self.colony.looks.get(&id) {
            Some(l) => crate::glossy::GlossyLook { tone: l.tone, eyes: l.eyes, hat: l.hat, outfit: l.outfit },
            None => crate::glossy::look_from_traits(&mind.traits),
        };
        crate::glossy::render(&look, mind.appearance(), frame, id)
    }

    fn as_token(&self, id: u64, mind: &Mind) -> Token {
        let svg = self.glossy_svg(id, mind, true);
        let media = format!("data:image/svg+xml;base64,{}", BASE64.encode(svg.as_bytes()));
        let state = self.mind_state(id).unwrap_or_default();
        let metadata = TokenMetadata {
            title: Some(mind.name.clone()),
            description: Some(format!(
                "A living Mind that pays for its own thoughts. Right now it is {state}."
            )),
            media: Some(media),
            media_hash: None,
            copies: Some(1),
            // NEP-177 wants epoch milliseconds; born_ts is the block timestamp in nanoseconds
            issued_at: Some((mind.born_ts / 1_000_000).to_string()),
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(format!(
                "{{\"state\":\"{state}\",\"thoughts\":{},\"balance_yocto\":\"{}\"}}",
                mind.thought_count,
                mind.balance.as_yoctonear()
            )),
            reference: None,
            reference_hash: None,
        };
        Token {
            token_id: id.to_string(),
            owner_id: mind.owner.clone(),
            metadata: Some(metadata),
            // NEP-178: surface current approvals (empty map signals the extension is supported).
            approved_account_ids: Some(
                mind.approvals
                    .iter()
                    .map(|(a, id)| (a.clone(), *id))
                    .collect::<HashMap<AccountId, u64>>(),
            ),
        }
    }

    /// A delivered thought's cost pays the brain that answered it. An approved responder (the
    /// worker, which runs the model and pays the `respond` gas) earns it; the contract account,
    /// or a keeper answering their own Mind, sends it to the treasury instead, so a keeper can
    /// never turn their Mind's food into their own money.
    fn pay_for_thought(&mut self, mind_id: u64, cost: u128, responder: Option<AccountId>) {
        let owner = self.minds.get(&mind_id).map(|m| m.owner.clone());
        match responder {
            Some(r) if r != env::current_account_id() && Some(&r) != owner.as_ref() && responders().contains(&r) => {
                let mut earned = responder_earnings();
                let prev = earned.get(&r).copied().unwrap_or(0);
                earned.insert(r, prev.saturating_add(cost));
            }
            _ => self.treasury = self.treasury.saturating_add(NearToken::from_yoctonear(cost)),
        }
    }

    /// Take and zero the owner's accrued earnings (`owner_unclaimed`). NEVER touches the Mind's balance.
    fn take_owner_earnings(&mut self, id: u64) -> NearToken {
        let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
        let amount = mind.owner_unclaimed;
        mind.owner_unclaimed = NearToken::from_yoctonear(0);
        amount
    }

    /// Park a yielded promise for a thought and store the request so the off-chain worker
    /// (worker/index.js -> NEAR AI Cloud) can pick it up and resume it with a reply. Returns the
    /// yielded promise (the caller's transaction pauses here until a reply or the 200-block
    /// timeout). The thought's cost has already been spent by the caller.
    /// `escrow` = (payer, deposit, service) for a guest thought; None for the owner's own.
    fn park_thought(
        &mut self,
        mind_id: u64,
        prompt: String,
        by_owner: bool,
        cost_paid: u128,
        escrow: Option<(AccountId, u128, Option<u64>)>,
    ) -> Promise {
        let rid = self.next_request;
        self.next_request += 1;
        let args = near_sdk::serde_json::json!({ "mind_id": mind_id, "request_id": rid })
            .to_string()
            .into_bytes();
        let (promise, yield_id) =
            Promise::new_yield("on_thought", args, GAS_FOR_THINK_CALLBACK, GasWeight::default());
        let (payer, escrow, service_id) = match escrow {
            Some((p, e, s)) => (Some(p), e, s),
            None => (None, 0, None),
        };
        let keeper = payer.as_ref().and_then(|_| self.minds.get(&mind_id).map(|m| m.owner.clone()));
        self.pending.insert(
            rid,
            Pending { mind_id, prompt, by_owner, yield_id, cost_paid, payer, escrow, service_id, keeper },
        );
        env::log_str(&format!("thought_parked request={rid} mind={mind_id} by_owner={by_owner}"));
        promise
    }

    /// Resolve a parked thought: store a delivered reply, or refund a timed-out one. Pure
    /// enough to unit-test directly; the #[private] on_thought callback wraps it.
    fn finalize_thought(&mut self, mind_id: u64, outcome: Result<String, ()>, now: u64, cost: u128) {
        let mind = match self.minds.get_mut(&mind_id) {
            Some(m) => m,
            None => return,
        };
        match outcome {
            Ok(reply) => {
                // Cap the stored reply (char-safe) — a responder could send any length, so this
                // bounds storage griefing from an over-long payload.
                mind.last_reply = if reply.chars().count() > MAX_REPLY_LEN {
                    reply.chars().take(MAX_REPLY_LEN).collect()
                } else {
                    reply
                };
                mind.last_reply_ts = now;
            }
            Err(()) => {
                // No compute was delivered — refund exactly what the Mind paid for this
                // thought (the cost locked in at spend time), and wake it if that very
                // payment was what put it to sleep.
                mind.balance = mind
                    .balance
                    .saturating_add(NearToken::from_yoctonear(cost));
                if mind.asleep_since != 0 && mind.balance.as_yoctonear() >= cost {
                    mind.asleep_since = 0;
                    mind.last_metabolism_ts = now; // fresh clock on wake (as feed/revive do),
                    // so the parked-sleep gap is not back-charged by the next settle
                }
            }
        }
    }

    /// Settle the departing owner's unclaimed cut and move the token to `receiver_id`.
    /// Shared by nft_transfer and nft_transfer_call. The caller may be the owner, or an
    /// account the owner approved (NEP-178) — then `approval_id`, if given, must match.
    /// Approvals are cleared on every transfer and returned to the caller, which then either
    /// refunds their storage to the old owner (a final transfer) or restores them (a reverted
    /// transfer_call). Returns the previous owner and the approvals that were cleared.
    fn hand_over(
        &mut self,
        id: u64,
        sender: &AccountId,
        receiver_id: &AccountId,
        approval_id: Option<u64>,
        memo: &Option<String>,
    ) -> (AccountId, BTreeMap<AccountId, u64>) {
        let (old_owner, by_approved) = {
            let mind = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            let by_owner = *sender == mind.owner;
            if !by_owner {
                // NEP-178: an approved account may transfer on the owner's behalf.
                match mind.approvals.get(sender) {
                    None => env::panic_str("only the token owner or an approved account may transfer it"),
                    Some(actual) => require!(approval_id.is_none() || approval_id.as_ref() == Some(actual), "approval_id does not match"),
                }
            }
            require!(*receiver_id != mind.owner, "cannot transfer a Mind to its current owner");
            (mind.owner.clone(), !by_owner)
        };
        // Settle the departing owner's unclaimed guest-chat cut so the buyer never inherits it.
        // (It always goes to the seller/old owner, even when a marketplace moves the token.)
        let cut = self.take_owner_earnings(id);
        if cut.as_yoctonear() > 0 {
            let _ = near_sdk::Promise::new(old_owner.clone()).transfer(cut);
        }
        // Hand over the token. The Mind's balance, traits and life-so-far (born time,
        // thought count) are keyed to the token id, so they travel with it untouched.
        // The new owner starts with a clean approval slate; the cleared approvals are
        // returned so the caller can refund their storage (final transfer) or restore them
        // (reverted transfer_call).
        // A Mind that changes hands is no longer for sale. Her agent, like her services and
        // reputation, goes with her when it runs on the platform (an approved responder: the
        // official / by-URL agent gateway). An agent on the seller's own account is unplugged:
        // otherwise that account would keep delivering her jobs and earning from her food after
        // the sale. The buyer plugs in their own.
        self.clear_listing(id);
        agents::unplug_personal_agent(id, |a| a == &env::current_account_id() || responders().contains(a));
        let cleared = {
            let mind = self.minds.get_mut(&id).unwrap();
            mind.owner = receiver_id.clone();
            std::mem::take(&mut mind.approvals)
        };

        let tid = id.to_string();
        let authorized = if by_approved { Some(sender.as_ref()) } else { None };
        near_contract_standards::non_fungible_token::events::NftTransfer {
            old_owner_id: old_owner.as_ref(),
            new_owner_id: receiver_id.as_ref(),
            token_ids: &[tid.as_str()],
            authorized_id: authorized,
            memo: memo.as_deref(),
        }
        .emit();
        (old_owner, cleared)
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

    /// The living-Minds leaderboard: ranked by thoughts (most active first), ties broken by
    /// balance (best-fed first). Ghosts are dead and never appear. `limit` is capped at 50
    /// (default 10). A read-only view — it scans all Minds, which is fine at demo scale.
    pub fn leaderboard(&self, limit: Option<u64>) -> Vec<MindRank> {
        let lim = limit.map(|l| (l as usize).min(50)).unwrap_or(10);
        let mut rows: Vec<MindRank> = self
            .minds
            .iter()
            .filter(|(_, m)| !m.ghost)
            .map(|(id, m)| MindRank {
                id: *id,
                name: m.name.clone(),
                thoughts: m.thought_count,
                balance: m.balance,
                state: self.mind_state(*id).unwrap_or_default(),
            })
            .collect();
        rows.sort_by(|a, b| {
            b.thoughts
                .cmp(&a.thoughts)
                .then(b.balance.as_yoctonear().cmp(&a.balance.as_yoctonear()))
        });
        rows.truncate(lim);
        rows
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
        self.minds.get(&id).map(|m| self.glossy_svg(id, m, true))
    }

    /// Same creature, same live state, but with no background window — for the web
    /// habitat where the Mind floats in its own light beam. The chain still draws it.
    pub fn svg_for_bare(&self, id: u64) -> Option<String> {
        self.minds.get(&id).map(|m| self.glossy_svg(id, m, false))
    }

    // --- NEP-171 / NEP-177 / NEP-181: the wallet + indexer surface ---

    /// Collection-level metadata (NEP-177).
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Hungry Minds".to_string(),
            symbol: "MIND".to_string(),
            // the collection's face in wallets and marketplaces: a plain pink Mind, drawn by the
            // same on-chain renderer as every token
            icon: Some(format!(
                "data:image/svg+xml;base64,{}",
                BASE64.encode(crate::glossy::render(&crate::glossy::GlossyLook { tone: 0, eyes: 0, hat: 0, outfit: 0 }, Appearance::Full, true, 0))
            )),
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }

    /// One token's full view, with live on-chain SVG media (NEP-171).
    pub fn nft_token(&self, token_id: String) -> Option<Token> {
        let id: u64 = token_id.parse().ok()?;
        let mind = self.minds.get(&id)?;
        Some(self.as_token(id, mind))
    }

    /// Total minted (NEP-181).
    pub fn nft_total_supply(&self) -> U128 {
        U128(self.minds.len() as u128)
    }

    /// A page of all tokens (NEP-181). Each token re-renders its SVG, so the page is
    /// capped at 50 to keep a single view call bounded.
    pub fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        let from = from_index.map(|U128(i)| i as usize).unwrap_or(0);
        let lim = limit.map(|l| (l as usize).min(50)).unwrap_or(50);
        self.minds
            .iter()
            .skip(from)
            .take(lim)
            .map(|(id, m)| self.as_token(*id, m))
            .collect()
    }

    /// How many tokens an account owns (NEP-181).
    pub fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        U128(self.minds.iter().filter(|(_, m)| m.owner == account_id).count() as u128)
    }

    /// A page of one account's tokens (NEP-181).
    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let from = from_index.map(|U128(i)| i as usize).unwrap_or(0);
        let lim = limit.map(|l| (l as usize).min(50)).unwrap_or(50);
        self.minds
            .iter()
            .filter(|(_, m)| m.owner == account_id)
            .skip(from)
            .take(lim)
            .map(|(id, m)| self.as_token(*id, m))
            .collect()
    }

    /// Hatch a new Mind. Payable: >= 1 NEAR. Rolls traits from block randomness,
    /// seeds the Mind's balance, routes the rest per the mint split, and returns the id.
    #[payable]
    pub fn hatch_mind(&mut self, name: String, look: Option<Look>) -> u64 {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(self.next_id < MAX_SUPPLY, "only 4000 Minds will ever hatch");
        if let Some(l) = &look {
            l.assert_valid();
        }
        require!(deposit >= economy::MINT_PRICE, "hatch needs at least 1 NEAR");
        // Bound the one free-form field so a long name can't lock more storage stake
        // than the 0.25 NEAR reserve ever refunds.
        require!(!name.is_empty() && name.len() <= 32, "name must be 1..=32 bytes");
        let split = economy::mint_split(deposit);
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.treasury));

        let t = traits::derive_traits(&env::random_seed());
        let now = env::block_timestamp();
        let id = self.next_id;
        let owner = env::predecessor_account_id();
        self.minds.insert(
            id,
            Mind {
                owner: owner.clone(),
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
                last_metabolism_ts: now,
                asleep_since: 0,
                thought_count: 0,
                ghost: false,
                owner_unclaimed: NearToken::from_yoctonear(0),
                last_reply: String::new(),
                last_reply_ts: 0,
                approvals: BTreeMap::new(),
                next_approval_id: 1,
            },
        );
        self.next_id += 1;
        // The cosmetic look rides on the 0.25 NEAR hatch reserve (a few dozen bytes).
        if let Some(l) = look {
            self.colony.looks.insert(id, l);
        }

        let token_id = id.to_string();
        near_contract_standards::non_fungible_token::events::NftMint {
            owner_id: owner.as_ref(),
            token_ids: &[token_id.as_str()],
            memo: None,
        }
        .emit();
        id
    }

    /// Feed a Mind: 95% to its balance, 5% to treasury. Wakes it if it can now
    /// afford a thought. Ghosts must be revived, not fed.
    #[payable]
    pub fn feed(&mut self, id: u64) {
        let now = env::block_timestamp();
        self.settle_metabolism(id, now); // realise any overdue idle drain before topping up
        let split = economy::feed_split(env::attached_deposit().as_yoctonear());
        let cost = self.thought_cost;
        let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
        require!(!mind.ghost, "a ghost cannot be fed");
        mind.balance = mind
            .balance
            .saturating_add(NearToken::from_yoctonear(split.to_mind));
        if mind.asleep_since != 0 && mind.balance.as_yoctonear() >= cost {
            mind.asleep_since = 0; // woke up
            mind.last_metabolism_ts = now; // fresh clock — the asleep gap is not back-charged
        }
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
    }

    /// Instant paid comeback for an *asleep* Mind: attach >= `revive_price`; the split sends
    /// the premium share to treasury and the rest into the Mind's locked food, waking it at
    /// once. This is never the only way back: `feed`ing her a little also wakes her (just
    /// slower), so revive is a convenience, not a ransom.
    /// A ghost (reaped after the long sleep) is a permanent memorial and is NOT revived here.
    #[payable]
    pub fn revive(&mut self, id: u64) {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.revive_price, "revive needs at least the revive price");
        let now = env::block_timestamp();
        let cost = self.thought_cost;
        self.settle_metabolism(id, now); // an awake-but-overdue Mind settles to asleep first
        let split = economy::revive_split(deposit);
        {
            let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!(!mind.ghost, "a ghost is a memorial and cannot be revived");
            require!(mind.asleep_since != 0, "this Mind is awake — no need to revive");
            mind.balance = mind
                .balance
                .saturating_add(NearToken::from_yoctonear(split.to_mind));
            // Revive must deliver its one promised effect: never take the deposit and leave
            // the Mind asleep. If the deposit cannot lift it to one thought, revert entirely.
            require!(mind.balance.as_yoctonear() >= cost, "revive deposit too small to wake this Mind — attach more");
            mind.asleep_since = 0; // guaranteed awake
            mind.last_metabolism_ts = now; // fresh clock after waking
        }
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
    }

    /// The owner talks to their own Mind: spends one thought from its balance.
    pub fn think(&mut self, id: u64, prompt: String) -> Promise {
        require!(prompt.len() <= MAX_PROMPT_LEN, "prompt too long");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let cost = self.thought_cost;
        self.settle_metabolism(id, now); // a long-neglected Mind may already be asleep
        {
            let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!((caller) == (mind.owner), "only the owner can use think()");
            require!(!mind.ghost, "this Mind is a ghost: a ghost can't think");
            // The Mind pays for the thought up front; a timeout refunds it (finalize_thought).
            require!(mind.spend_one_thought(now, cost), "this Mind is asleep — feed it");
        }
        self.park_thought(id, prompt, true, cost, None)
    }

    /// A stranger pays to talk to a public Mind (90% owner / 10% protocol) and it thinks a reply.
    #[payable]
    pub fn chat(&mut self, id: u64, prompt: String) -> Promise {
        // A guest must cover the thought they trigger, or a free-rider could drain the
        // Mind's food one thought at a time for only gas. See `guest_min_price`.
        let min = self.guest_min_price;
        self.guest_think(id, prompt, min, None)
    }

    /// The off-chain worker (worker/index.js -> NEAR AI Cloud) returns a reply here, resuming
    /// the parked thought. The worker checks NEAR AI Cloud's TEE signature over the reply
    /// OFF-CHAIN (EIP-191, worker/near-ai.js) for the "verified ✓" badge; the contract never
    /// gates money on a signature.
    pub fn respond(&mut self, request_id: u64, reply: String) {
        let p = self.pending.get(&request_id).unwrap_or_else(|| env::panic_str("no such pending thought"));
        // Only a trusted brain may put words in a Mind's mouth: an approved responder (the
        // worker), the contract account, or the keeper answering their own Mind's thought.
        let caller = env::predecessor_account_id();
        let own_thought = p.by_owner && self.minds.get(&p.mind_id).is_some_and(|m| m.owner == caller);
        require!(
            caller == env::current_account_id() || own_thought || responders().contains(&caller),
            "only an approved responder may answer this thought"
        );
        // Resume the parked promise; on_thought then stores the reply, clears the request and
        // pays the thought's cost to whoever answered it (recorded only if the resume landed).
        let data = near_sdk::serde_json::to_vec(&reply).unwrap_or_else(|_| env::panic_str("serialize reply"));
        if p.yield_id.resume(data).is_ok() {
            answered_by().insert(request_id, caller);
        }
    }

    /// Callback when a parked thought resolves — a reply arrived, or it timed out (200 blocks).
    #[private]
    pub fn on_thought(
        &mut self,
        mind_id: u64,
        request_id: u64,
        #[callback_result] reply: Result<String, PromiseError>,
    ) {
        let now = env::block_timestamp();
        self.resolve_thought(mind_id, request_id, reply.map_err(|_| ()), now);
    }

    /// The Mind's most recent delivered thought (empty until it has thought once).
    pub fn last_thought(&self, id: u64) -> Option<String> {
        self.minds.get(&id).map(|m| m.last_reply.clone())
    }

    /// How many thoughts are currently in flight (awaiting a reply).
    pub fn pending_count(&self) -> u64 {
        self.pending.len() as u64
    }

    /// Thoughts awaiting a reply — the off-chain worker polls this, computes, and calls
    /// `respond`. Paginated (≤ 50).
    pub fn pending_requests(
        &self,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<PendingView> {
        let from = from_index.map(|U128(i)| i as usize).unwrap_or(0);
        let lim = limit.map(|l| (l as usize).min(50)).unwrap_or(50);
        self.pending
            .iter()
            .skip(from)
            .take(lim)
            .map(|(rid, p)| PendingView {
                request_id: *rid,
                mind_id: p.mind_id,
                prompt: p.prompt.clone(),
                by_owner: p.by_owner,
            })
            .collect()
    }

    /// Owner withdraws their accrued earnings (`owner_unclaimed`), never the Mind's food.
    pub fn claim_earnings(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        {
            let mind = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!((caller) == (mind.owner), "only the owner can claim earnings");
        }
        let amount = self.take_owner_earnings(id);
        if amount.as_yoctonear() > 0 {
            // Dropping the Promise schedules it (near-sdk Promise::drop -> construct_recursively).
            let _ = near_sdk::Promise::new(caller).transfer(amount);
        }
    }

    /// Reap a Mind that has slept past `GHOST_AFTER_NS` into a ghost and credit its
    /// 0.25 NEAR hatch reserve back to the owner as a claimable rebate. Callable by
    /// anyone (a keeper action); on the testnet demo build the window is minutes.
    pub fn reap(&mut self, id: u64) {
        let now = env::block_timestamp();
        {
            let mind = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!(!mind.ghost, "already a ghost");
            require!(crate::state::is_reapable(mind.asleep_since, now), "not ready to reap — still within the sleep window");
        }
        let mind = self.minds.get_mut(&id).unwrap();
        mind.ghost = true;
        // Credit the hatch reserve to the owner as a *claimable* amount (pull pattern):
        // a push transfer to a stored owner account that has since been deleted would
        // strand the funds after ghost=true is committed. The owner withdraws it via
        // claim_earnings (which works on a ghost too).
        mind.owner_unclaimed = mind
            .owner_unclaimed
            .saturating_add(NearToken::from_yoctonear(economy::MINT_STORAGE_RESERVE));
    }

    // --- Governance: the contract account retunes the economy's prices -------------------
    // The admin is the contract account itself: a call whose predecessor is the contract's
    // own account (the key controlling it). No separate owner field, so nothing to init.

    /// The live economy prices, read from chain by the web app and worker.
    pub fn params(&self) -> EconomyParams {
        EconomyParams {
            thought_cost: NearToken::from_yoctonear(self.thought_cost),
            guest_min_price: NearToken::from_yoctonear(self.guest_min_price),
            revive_price: NearToken::from_yoctonear(self.revive_price),
            mint_price: NearToken::from_yoctonear(economy::MINT_PRICE),
            idle_rate_per_day: self.idle_rate_per_day,
        }
    }

    fn assert_admin(&self) {
        require!((env::predecessor_account_id()) == (env::current_account_id()), "only the contract account may change economy parameters");
    }

    /// Allow `account_id` to answer parked thoughts (the worker). Contract account only.
    pub fn add_responder(&mut self, account_id: AccountId) {
        self.assert_admin();
        let mut r = responders();
        r.insert(account_id);
    }

    pub fn remove_responder(&mut self, account_id: AccountId) {
        self.assert_admin();
        let mut r = responders();
        r.remove(&account_id);
    }

    pub fn is_responder(&self, account_id: AccountId) -> bool {
        account_id == env::current_account_id() || responders().contains(&account_id)
    }

    /// What `account_id` has earned answering thoughts and not yet claimed.
    pub fn responder_earnings_of(&self, account_id: AccountId) -> NearToken {
        NearToken::from_yoctonear(responder_earnings().get(&account_id).copied().unwrap_or(0))
    }

    /// A responder withdraws what it earned answering thoughts (one thought cost per reply).
    pub fn claim_responder_earnings(&mut self) {
        let caller = env::predecessor_account_id();
        let mut earned = responder_earnings();
        let amount = earned.remove(&caller).unwrap_or(0);
        if amount > 0 {
            let _ = Promise::new(caller).transfer(NearToken::from_yoctonear(amount));
        }
    }

    /// Send `amount` of the treasury to `receiver_id`. Contract account only. The treasury is
    /// the only money that can leave this way: it is a separate counter from every Mind's
    /// food, owner earnings and responder earnings, and the withdrawal must leave the storage
    /// stake plus `TREASURY_FLOAT` covered. If the transfer fails, the amount returns to it.
    pub fn withdraw_treasury(&mut self, receiver_id: AccountId, amount: U128) -> Promise {
        self.assert_admin();
        let a = amount.0;
        require!(a > 0, "amount must be positive");
        require!(a <= self.treasury.as_yoctonear(), "amount exceeds the treasury");
        let stake = env::storage_byte_cost().as_yoctonear().saturating_mul(env::storage_usage() as u128);
        require!(
            env::account_balance().as_yoctonear().saturating_sub(a) >= stake.saturating_add(TREASURY_FLOAT),
            "withdrawal would leave too little to cover the contract's storage"
        );
        self.treasury = NearToken::from_yoctonear(self.treasury.as_yoctonear() - a);
        env::log_str(&format!("treasury_withdraw to={receiver_id} amount={a}"));
        Promise::new(receiver_id).transfer(NearToken::from_yoctonear(a)).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_WITHDRAW_CALLBACK)
                .on_treasury_withdrawn(amount),
        )
    }

    /// Callback after `withdraw_treasury`: a failed transfer puts the amount back.
    #[private]
    pub fn on_treasury_withdrawn(&mut self, amount: U128, #[callback_result] sent: Result<(), PromiseError>) {
        if sent.is_err() {
            self.treasury = self.treasury.saturating_add(NearToken::from_yoctonear(amount.0));
            env::log_str(&format!("treasury_withdraw_failed amount={}", amount.0));
        }
    }

    /// Re-peg the cost of one thought to the real inference price. Bounded by `economy::MAX_THOUGHT_COST` so a
    /// mis-set or hostile admin key cannot make Minds bankrupt themselves in a single thought.
    pub fn set_thought_cost(&mut self, yocto: U128) {
        self.assert_admin();
        let c = yocto.0;
        require!(c > 0, "thought cost must be positive");
        require!(c <= economy::MAX_THOUGHT_COST, "thought cost above the safety ceiling");
        // Keep the guest-covers-a-thought invariant: the owner's 90% of a minimum guest
        // payment must exceed the food one reply costs. Re-pegging the cost up
        // therefore requires raising the guest minimum first.
        require!(economy::guest_split(self.guest_min_price).to_owner > c, "thought cost too high for the guest minimum — raise the guest minimum first");
        self.thought_cost = c;
        env::log_str(&format!("param_set thought_cost={c}"));
    }

    /// Set the minimum a guest must attach to `chat`. Kept at or above the thought cost so a
    /// guest always covers the thought they trigger (no free-rider drain).
    pub fn set_guest_min_price(&mut self, yocto: U128) {
        self.assert_admin();
        let p = yocto.0;
        // The owner keeps 90%, so compare THAT to the food a reply costs, not the gross deposit.
        require!(economy::guest_split(p).to_owner > self.thought_cost, "guest minimum must cover a thought after the 10% protocol fee");
        self.guest_min_price = p;
        env::log_str(&format!("param_set guest_min_price={p}"));
    }

    /// Set the minimum paid-`revive` deposit. Feeding still wakes her for free, so this never
    /// becomes the only way back.
    pub fn set_revive_price(&mut self, yocto: U128) {
        self.assert_admin();
        let p = yocto.0;
        // The minimum revive must actually wake a Mind: its 80% share has to reach one thought.
        require!(economy::revive_split(p).to_mind >= self.thought_cost, "revive price must be enough to wake a Mind");
        self.revive_price = p;
        env::log_str(&format!("param_set revive_price={p}"));
    }

    /// Retune the autonomous-metabolism rate (thoughts/day a neglected Mind burns). Bounded by
    /// MAX_IDLE_RATE; zero is rejected (the game needs metabolism to run).
    pub fn set_idle_rate(&mut self, thoughts_per_day: u64) {
        self.assert_admin();
        require!(thoughts_per_day > 0, "idle rate must be positive");
        require!(thoughts_per_day <= crate::state::MAX_IDLE_RATE, "idle rate above the ceiling");
        self.idle_rate_per_day = thoughts_per_day;
        env::log_str(&format!("param_set idle_rate_per_day={thoughts_per_day}"));
    }

    // --- Autonomous metabolism (neglect makes a Mind hungry over time) -------------------
    // The contract has no cron, so idle drain is applied lazily: every interaction settles it
    // first, and `settle` lets a keeper or the web app realise it on chain between touches.
    // Read-only `live_*` views show the current, not-yet-settled state for free.

    /// Charge a Mind's metabolism from its last settle up to `now`, flipping it to sleep if it
    /// starves. No-op on a ghost or an already-asleep Mind (so a sleep gap is never charged).
    fn settle_metabolism(&mut self, id: u64, now: u64) {
        let rate = self.idle_rate_per_day;
        let cost = self.thought_cost;
        let mind = match self.minds.get_mut(&id) {
            Some(m) => m,
            None => return,
        };
        if mind.ghost || mind.asleep_since != 0 {
            return;
        }
        let elapsed = now.saturating_sub(mind.last_metabolism_ts);
        let (n, consumed) = crate::state::idle_thoughts(elapsed, rate);
        if n == 0 {
            return;
        }
        let drain = (n as u128).saturating_mul(cost);
        let bal = mind.balance.as_yoctonear();
        let eaten = drain.min(bal);
        if drain >= bal {
            mind.balance = NearToken::from_yoctonear(0);
            mind.asleep_since = now; // starved into sleep
            mind.last_metabolism_ts = now; // keep the clock current so a later wake-without-reset
            // can never back-charge this already-settled interval
        } else {
            mind.balance = NearToken::from_yoctonear(bal - drain);
            mind.last_metabolism_ts = mind.last_metabolism_ts.saturating_add(consumed);
            if mind.balance.as_yoctonear() < cost {
                mind.asleep_since = now; // too poor to afford even one thought
            }
        }
        // Idle metabolism runs no model, so no responder earns it: the food it burns goes to
        // the treasury rather than vanishing into the contract's untracked balance.
        self.treasury = self.treasury.saturating_add(NearToken::from_yoctonear(eaten));
    }

    /// Permissionless keeper action: settle a Mind's metabolism now. Anyone (the web app, a
    /// keeper, the worker) may call it; it only ever applies drain the Mind already owes.
    pub fn settle(&mut self, id: u64) {
        let now = env::block_timestamp();
        self.settle_metabolism(id, now);
    }

    /// Effective food NOW, applying idle drain not yet settled on chain (read-only).
    fn effective_balance(&self, m: &Mind, now: u64) -> u128 {
        if m.ghost || m.asleep_since != 0 {
            return m.balance.as_yoctonear();
        }
        let (n, _) = crate::state::idle_thoughts(
            now.saturating_sub(m.last_metabolism_ts),
            self.idle_rate_per_day,
        );
        let drain = (n as u128).saturating_mul(self.thought_cost);
        m.balance.as_yoctonear().saturating_sub(drain)
    }

    /// A Mind's food RIGHT NOW, including idle drain not yet settled (read-only, no gas).
    pub fn live_balance(&self, id: u64) -> Option<NearToken> {
        let now = env::block_timestamp();
        self.minds
            .get(&id)
            .map(|m| NearToken::from_yoctonear(self.effective_balance(m, now)))
    }

    /// A Mind's visible state RIGHT NOW, including idle drain not yet settled (read-only).
    pub fn live_state(&self, id: u64) -> Option<String> {
        let now = env::block_timestamp();
        self.minds.get(&id).map(|m| {
            if m.ghost {
                return "ghost".to_string();
            }
            if m.asleep_since != 0 {
                return "asleep".to_string();
            }
            let eff = self.effective_balance(m, now);
            // Mirror settle's second sleep rule: below one thought the Mind cannot think, so
            // the next settle/interaction would flip it asleep. Predict that here, else the
            // view would say "starving" for a Mind any touch instantly puts to sleep.
            if eff < self.thought_cost {
                return "asleep".to_string();
            }
            match hunger_state(eff) {
                HungerState::Full => "full",
                HungerState::Content => "content",
                HungerState::Hungry => "hungry",
                HungerState::Starving => "starving",
                HungerState::Asleep => "asleep",
            }
            .to_string()
        })
    }

    /// NEP-171 transfer. A Mind is sold whole: its food balance, traits and life-so-far
    /// (all keyed to the token) travel to the new owner untouched. The ONE thing that
    /// does not travel is the departing owner's unclaimed guest-chat cut — that is
    /// settled to them on the way out, so a buyer never inherits someone else's earnings.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        near_sdk::assert_one_yocto();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        let sender = env::predecessor_account_id();
        // A direct transfer is final: refund the cleared approvals' storage to the old owner.
        let (old_owner, cleared) = self.hand_over(id, &sender, &receiver_id, approval_id, &memo);
        refund_cleared_approvals(&cleared, &old_owner);
    }

    /// NEP-171 transfer-and-call: move the token, then invoke `nft_on_transfer` on the
    /// receiver; if it asks to return the token (or fails), `nft_resolve_transfer` reverts
    /// ownership. This is what marketplaces and receiver contracts use.
    #[payable]
    pub fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        near_sdk::assert_one_yocto();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        let sender = env::predecessor_account_id();
        let (old_owner, cleared) = self.hand_over(id, &sender, &receiver_id, approval_id, &memo);

        ext_nft_receiver::ext(receiver_id.clone())
            .with_static_gas(GAS_FOR_NFT_ON_TRANSFER)
            .nft_on_transfer(sender, old_owner.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .nft_resolve_transfer(old_owner, receiver_id, token_id, cleared),
            )
            .into()
    }

    /// Callback after `nft_on_transfer`. Returns true if the receiver kept the token;
    /// if it asked to return it (or the call failed), ownership is reverted.
    #[private]
    pub fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: String,
        cleared_approvals: BTreeMap<AccountId, u64>,
    ) -> bool {
        // A bool is a few bytes; cap the read. Ok -> parse the receiver's answer,
        // Err (failed or oversized) -> treat as "return the token".
        let outcome = match env::promise_result_checked(0, 16) {
            Ok(value) => Ok(near_sdk::serde_json::from_slice::<bool>(&value).unwrap_or(false)),
            Err(_) => Err(()),
        };
        if !should_revert(outcome) {
            // The transfer stands: the old approvals are gone for good, so refund the storage
            // the previous owner staked for them.
            refund_cleared_approvals(&cleared_approvals, &previous_owner_id);
            return true;
        }
        // Revert ownership to the previous owner, but only if the receiver still holds it. The
        // approvals hand_over cleared are restored too, so a bounced transfer is a true no-op.
        if let Ok(id) = token_id.parse::<u64>() {
            if let Some(mind) = self.minds.get_mut(&id) {
                if mind.owner == receiver_id {
                    mind.owner = previous_owner_id.clone();
                    mind.approvals = cleared_approvals;
                    let tid = id.to_string();
                    near_contract_standards::non_fungible_token::events::NftTransfer {
                        old_owner_id: receiver_id.as_ref(),
                        new_owner_id: previous_owner_id.as_ref(),
                        token_ids: &[tid.as_str()],
                        authorized_id: None,
                        memo: Some("nft_transfer_call reverted"),
                    }
                    .emit();
                }
            }
        }
        false
    }

    // --- NEP-199: payouts, so outside NEAR marketplaces can sell a Mind ---

    /// Who gets what of a sale of `balance`: no royalties, all of it to the owner (as in the
    /// built-in market; the protocol's 10% is on what people pay to use a Mind, not on sales).
    pub fn nft_payout(&self, token_id: String, balance: U128, max_len_payout: Option<u32>) -> Payout {
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        require!(max_len_payout.is_none_or(|n| n >= 1), "max_len_payout must be at least 1");
        let owner = self.minds.get(&id).unwrap_or_else(|| env::panic_str("no such Mind")).owner.clone();
        Payout { payout: HashMap::from([(owner, balance)]) }
    }

    /// A marketplace's transfer that also returns the payout (NEP-199). Same rules as
    /// nft_transfer: the owner or an approved account, one yoctoNEAR attached.
    #[payable]
    pub fn nft_transfer_payout(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
        balance: U128,
        max_len_payout: Option<u32>,
    ) -> Payout {
        near_sdk::assert_one_yocto();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        require!(max_len_payout.is_none_or(|n| n >= 1), "max_len_payout must be at least 1");
        let sender = env::predecessor_account_id();
        let (old_owner, cleared) = self.hand_over(id, &sender, &receiver_id, approval_id, &memo);
        refund_cleared_approvals(&cleared, &old_owner);
        Payout { payout: HashMap::from([(old_owner, balance)]) }
    }

    // --- NEP-178: approval management (marketplace support) ---

    /// Approve `account_id` to transfer this Mind on the owner's behalf. Payable: the owner
    /// covers the storage of a new approval; any excess deposit is refunded. With `msg`, the
    /// approved contract's `nft_on_approve` is called — how a marketplace gets told to list it.
    #[payable]
    pub fn nft_approve(
        &mut self,
        token_id: String,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "approving needs a deposit (>= 1 yoctoNEAR) to cover approval storage");
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        let (owner, approval_id, is_new) = {
            let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!((env::predecessor_account_id()) == (mind.owner), "only the owner can approve");
            let approval_id = mind.next_approval_id;
            let is_new = mind.approvals.insert(account_id.clone(), approval_id).is_none();
            mind.next_approval_id += 1;
            (mind.owner.clone(), approval_id, is_new)
        };
        // Only a brand-new approval consumes storage; re-approving an account doesn't.
        let storage_used = if is_new { bytes_for_approval(&account_id) } else { 0 };
        refund_approval_deposit(storage_used);

        msg.map(|msg| {
            ext_nft_approval_receiver::ext(account_id)
                .with_static_gas(env::prepaid_gas().saturating_sub(GAS_FOR_NFT_APPROVE))
                .nft_on_approve(token_id, owner, approval_id, msg)
        })
    }

    /// Revoke one account's approval (owner only); refunds the freed storage to the owner.
    #[payable]
    pub fn nft_revoke(&mut self, token_id: String, account_id: AccountId) {
        near_sdk::assert_one_yocto();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        let removed = {
            let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!((env::predecessor_account_id()) == (mind.owner), "only the owner can revoke");
            mind.approvals.remove(&account_id).is_some()
        };
        if removed {
            refund_approval_storage(bytes_for_approval(&account_id), env::predecessor_account_id());
        }
    }

    /// Revoke every approval on this Mind (owner only); refunds the freed storage.
    #[payable]
    pub fn nft_revoke_all(&mut self, token_id: String) {
        near_sdk::assert_one_yocto();
        let id: u64 = token_id.parse().unwrap_or_else(|_| env::panic_str("token_id must be a number"));
        let freed: u64 = {
            let mind = self.minds.get_mut(&id).unwrap_or_else(|| env::panic_str("no such Mind"));
            require!((env::predecessor_account_id()) == (mind.owner), "only the owner can revoke");
            let sum = mind.approvals.keys().map(bytes_for_approval).sum();
            mind.approvals.clear();
            sum
        };
        if freed > 0 {
            refund_approval_storage(freed, env::predecessor_account_id());
        }
    }

    /// Is `approved_account_id` approved for this Mind (optionally with a specific
    /// `approval_id`)? NEP-178 view — returns false for an unknown token.
    pub fn nft_is_approved(
        &self,
        token_id: String,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        let id: u64 = match token_id.parse() {
            Ok(i) => i,
            Err(_) => return false,
        };
        match self.minds.get(&id) {
            Some(mind) => match mind.approvals.get(&approved_account_id) {
                Some(actual) => approval_id.map_or(true, |given| given == *actual),
                None => false,
            },
            None => false,
        }
    }
}

/// Approval storage size, mirrored from near-contract-standards: the account-id string, its
/// 4-byte borsh length prefix, and the 8-byte u64 approval_id.
fn bytes_for_approval(account_id: &AccountId) -> u64 {
    account_id.as_str().len() as u64 + 4 + 8
}

/// Require the attached deposit to cover `storage_used` bytes, and refund the excess to the
/// predecessor (NEP-178 `nft_approve`). near_sdk `store` maps flush lazily, so storage is
/// charged from a computed size rather than an `env::storage_usage()` delta.
fn refund_approval_deposit(storage_used: u64) {
    let cost = env::storage_byte_cost().saturating_mul(storage_used as u128);
    let attached = env::attached_deposit();
    require!(attached >= cost, "attach enough deposit to cover approval storage");
    let refund = attached.saturating_sub(cost);
    if refund.as_yoctonear() > 1 {
        let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
    }
}

/// Refund the NEAR staked for `bytes` of approval storage to `account` (on revoke).
fn refund_approval_storage(bytes: u64, account: AccountId) {
    let amount = env::storage_byte_cost().saturating_mul(bytes as u128);
    if amount.as_yoctonear() > 0 {
        let _ = Promise::new(account).transfer(amount);
    }
}

/// Refund the storage of a set of approvals cleared by a transfer, back to `to` (the old
/// owner). Keeps the approve/transfer storage accounting symmetric with revoke.
fn refund_cleared_approvals(approvals: &BTreeMap<AccountId, u64>, to: &AccountId) {
    let bytes: u64 = approvals.keys().map(bytes_for_approval).sum();
    if bytes > 0 {
        refund_approval_storage(bytes, to.clone());
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
            last_metabolism_ts: 0,
            asleep_since,
            thought_count: 0,
            ghost,
            owner_unclaimed: NearToken::from_yoctonear(0),
            last_reply: String::new(),
            last_reply_ts: 0,
            approvals: BTreeMap::new(),
            next_approval_id: 1,
        }
    }

    // --- hatch ---
    #[test]
    fn hatch_seeds_balance_rolls_traits_and_funds_treasury() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(10)).build());
        let mut c = Contract::default();
        let id = c.hatch_mind("Rue".to_string(), None);
        assert_eq!(id, 0);
        assert_eq!(c.total_minds(), 1);
        let m = c.get_mind(0).expect("minted");
        assert_eq!(m.owner, "alice.near".parse::<AccountId>().unwrap());
        assert_eq!(m.name, "Rue");
        assert_eq!(m.balance, NearToken::from_millinear(100));
        assert_eq!(m.traits[0], 10 % traits::N_TEMPERAMENT);
        assert!(!m.ghost);
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650));
    }

    #[test]
    #[should_panic(expected = "at least 1 NEAR")]
    fn hatch_below_one_near_panics() {
        testing_env!(ctx(NearToken::from_millinear(999), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("x".to_string(), None);
    }

    #[test]
    #[should_panic(expected = "name must be")]
    fn hatch_rejects_an_overlong_name() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("x".repeat(33), None);
    }

    #[test]
    #[should_panic(expected = "name must be")]
    fn hatch_rejects_an_empty_name() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind(String::new(), None);
    }

    // --- spend_one_thought ---
    #[test]
    fn thought_deducts_cost_and_bumps_count() {
        let mut m = make_mind(NearToken::from_near(1), false, 0);
        assert!(m.spend_one_thought(100, economy::THOUGHT_COMPUTE_COST));
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
        assert!(!m.spend_one_thought(200, economy::THOUGHT_COMPUTE_COST));
        assert_eq!(m.asleep_since, 200);
        assert_eq!(m.thought_count, 0);
    }

    #[test]
    fn asleep_and_ghost_minds_cannot_think() {
        let mut asleep = make_mind(NearToken::from_near(1), false, 50);
        assert!(!asleep.spend_one_thought(100, economy::THOUGHT_COMPUTE_COST));
        let mut ghost = make_mind(NearToken::from_near(1), true, 0);
        assert!(!ghost.spend_one_thought(100, economy::THOUGHT_COMPUTE_COST));
    }

    // --- feed ---
    #[test]
    fn feed_adds_95_to_mind_and_5_to_treasury() {
        testing_env!(ctx(NearToken::from_near(1), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None); // balance 0.1, treasury 0.65

        testing_env!(ctx(NearToken::from_millinear(500), seed_all(0)).build()); // feed 0.5
        c.feed(0);

        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(575)); // 0.1 + 0.475
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(675)); // 0.65 + 0.025
    }

    // --- mind_state ---
    #[test]
    fn mind_state_reports_each_state() {
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_near(1), false, 0)); // full
        c.minds
            .insert(1, make_mind(NearToken::from_millinear(10), false, 0)); // 0.01 hungry (10-30% of the bar)
        c.minds
            .insert(2, make_mind(NearToken::from_millinear(4), false, 0)); // 0.004 starving (under 10%)
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
    fn guest_chat_pays_90_10_and_spends_a_thought() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None); // balance 0.1, treasury 0.65

        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build()); // guest pays 0.01
        let _ = c.chat(0, "hi".to_string());

        // While the thought is in flight the deposit sits in escrow: only the thought is paid.
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(98));
        assert_eq!(m.owner_unclaimed, NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650));

        c.resolve_thought(0, 0, Ok("hello".to_string()), 1);
        let m = c.get_mind(0).unwrap();
        // her food pays only the thought: 0.1 - 0.002; her owner gets 90% of 0.01
        assert_eq!(m.balance, NearToken::from_millinear(98));
        assert_eq!(m.owner_unclaimed, NearToken::from_millinear(9)); // 0.009
        assert_eq!(m.thought_count, 1);
        // 0.65 + 0.001 (10%) + 0.002 thought: no approved responder answered, so the treasury keeps it
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(653));
    }

    fn ctx_on(who: &str, deposit: NearToken) -> VMContextBuilder {
        let mut b = ctx_from(who, deposit);
        b.current_account_id("hm.near".parse().unwrap());
        b
    }

    // --- who may answer a thought ---
    #[test]
    #[should_panic(expected = "only an approved responder may answer this thought")]
    fn a_stranger_cannot_answer_a_guest_thought() {
        testing_env!(ctx_on("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_on("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
        testing_env!(ctx_on("mallory.near", NearToken::from_yoctonear(0)).build());
        c.respond(0, "I am not her".to_string());
    }

    #[test]
    #[should_panic(expected = "only an approved responder may answer this thought")]
    fn the_keeper_cannot_answer_a_guest_thought() {
        testing_env!(ctx_on("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_on("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
        testing_env!(ctx_on("alice.near", NearToken::from_yoctonear(0)).build());
        c.respond(0, "made-up answer".to_string());
    }

    #[test]
    fn only_the_contract_account_manages_responders() {
        testing_env!(ctx_on("hm.near", NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        let w: AccountId = "worker.near".parse().unwrap();
        assert!(!c.is_responder(w.clone()));
        c.add_responder(w.clone());
        assert!(c.is_responder(w.clone()));
        c.remove_responder(w.clone());
        assert!(!c.is_responder(w));
    }

    #[test]
    #[should_panic(expected = "only the contract account")]
    fn a_stranger_cannot_add_a_responder() {
        testing_env!(ctx_on("mallory.near", NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.add_responder("mallory.near".parse().unwrap());
    }

    #[test]
    fn a_guest_payment_in_flight_during_a_sale_pays_the_new_owner() {
        testing_env!(ctx_on("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_on("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string()); // alice keeps her while bob pays
        testing_env!(ctx_on("alice.near", NearToken::from_yoctonear(0)).build());
        c.list_for_sale(0, U128(NearToken::from_near(1).as_yoctonear()));
        testing_env!(ctx_on("carol.near", NearToken::from_near(1)).build());
        c.buy_mind(0);
        c.resolve_thought(0, 0, Ok("hello".to_string()), 1);
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.owner.as_str(), "carol.near");
        // carol bought her before the reply landed: everything earned after the sale is hers,
        // alice keeps only the sale price
        assert_eq!(m.owner_unclaimed, NearToken::from_micronear(9000));
        // her food only paid the thought: 0.1 - 0.002
        assert_eq!(m.balance, NearToken::from_millinear(98));
    }

    #[test]
    fn a_timed_out_guest_chat_refunds_the_guest_and_the_thought() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());

        c.resolve_thought(0, 0, Err(()), 1);
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(100), "the thought cost is refunded");
        assert_eq!(m.owner_unclaimed, NearToken::from_yoctonear(0), "no cut for an undelivered reply");
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650), "no protocol fee either");
        assert_eq!(c.pending_count(), 0);
        // (the 0.01 itself goes back to bob as a transfer promise)
    }

    #[test]
    #[should_panic(expected = "your own Mind")]
    fn owner_cannot_use_chat() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
    }

    #[test]
    #[should_panic(expected = "below the guest minimum")]
    fn guest_chat_below_the_price_is_rejected() {
        // A free-rider attaching 0 must not be able to spend the Mind's food.
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(0)).build());
        let _ = c.chat(0, "hi".to_string());
    }

    // --- think (owner) ---
    #[test]
    fn owner_think_spends_a_thought_without_payment() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hey".to_string());

        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_millinear(98)); // 0.1 - 0.002
        assert_eq!(m.thought_count, 1);
        assert_eq!(m.owner_unclaimed, NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650)); // unchanged
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn non_owner_cannot_use_think() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
    }

    // --- the brain: yield/resume thinking ---
    #[test]
    fn think_parks_a_request_and_spends_a_thought() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "who are you?".to_string());

        assert_eq!(c.get_mind(0).unwrap().thought_count, 1); // paid up front
        assert_eq!(c.pending_count(), 1); // one thought in flight
        assert_eq!(c.last_thought(0).as_deref(), Some("")); // no reply delivered yet
        let reqs = c.pending_requests(None, None);
        assert_eq!(reqs.len(), 1);
        assert_eq!(reqs[0].mind_id, 0);
        assert_eq!(reqs[0].prompt, "who are you?");
        assert!(reqs[0].by_owner);
    }

    #[test]
    fn a_delivered_reply_is_stored_on_the_mind() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0));
        c.finalize_thought(0, Ok("I think, therefore I bill.".to_string()), 123, economy::THOUGHT_COMPUTE_COST);
        assert_eq!(c.last_thought(0).as_deref(), Some("I think, therefore I bill."));
        assert_eq!(c.get_mind(0).unwrap().last_reply_ts, 123);
    }

    #[test]
    fn an_overlong_reply_is_capped_to_bound_storage() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0));
        // a responder could try to store a huge reply.
        let huge = "é".repeat(5000); // multi-byte, to prove the cap is char-safe (no panic)
        c.finalize_thought(0, Ok(huge), 1, economy::THOUGHT_COMPUTE_COST);
        let stored = c.last_thought(0).unwrap();
        assert_eq!(stored.chars().count(), MAX_REPLY_LEN);
    }

    #[test]
    fn a_timed_out_thought_is_refunded_and_wakes_the_mind() {
        let mut c = Contract::default();
        // a Mind that spent its last affordable thought: 0.001 NEAR, asleep.
        c.minds.insert(
            0,
            make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000), false, 500),
        );
        c.finalize_thought(0, Err(()), 600, economy::THOUGHT_COMPUTE_COST);
        let after = c.get_mind(0).unwrap();
        // refunded the 0.002 it paid -> 0.003, which is affordable again -> awake
        assert_eq!(
            after.balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000 + economy::THOUGHT_COMPUTE_COST)
        );
        assert_eq!(after.asleep_since, 0);
    }

    // --- governable economy params + revive ---

    fn admin_ctx(deposit: NearToken) -> VMContextBuilder {
        // The admin is the contract account itself: predecessor == current_account_id.
        let mut b = VMContextBuilder::new();
        b.current_account_id("hm.near".parse().unwrap())
            .predecessor_account_id("hm.near".parse().unwrap())
            .attached_deposit(deposit)
            .random_seed(seed_all(0));
        b
    }

    #[test]
    fn params_view_reports_current_prices() {
        let c = Contract::default();
        let p = c.params();
        assert_eq!(p.thought_cost, NearToken::from_yoctonear(economy::THOUGHT_COMPUTE_COST));
        assert_eq!(p.guest_min_price, NearToken::from_yoctonear(economy::GUEST_PRICE));
        assert_eq!(p.revive_price, NearToken::from_yoctonear(economy::REVIVE_PRICE));
        assert_eq!(p.mint_price, NearToken::from_yoctonear(economy::MINT_PRICE));
    }

    #[test]
    fn contract_account_can_retune_the_thought_cost() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        let new_cost = crate::state::ONE_NEAR / 250; // 0.004
        c.set_thought_cost(U128(new_cost));
        assert_eq!(c.params().thought_cost, NearToken::from_yoctonear(new_cost));
    }

    #[test]
    #[should_panic(expected = "only the contract account")]
    fn a_stranger_cannot_retune_params() {
        let mut b = VMContextBuilder::new();
        b.current_account_id("hm.near".parse().unwrap())
            .predecessor_account_id("mallory.near".parse().unwrap());
        testing_env!(b.build());
        let mut c = Contract::default();
        c.set_thought_cost(U128(1));
    }

    #[test]
    #[should_panic(expected = "safety ceiling")]
    fn thought_cost_cannot_exceed_the_ceiling() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.set_thought_cost(U128(crate::state::ONE_NEAR)); // 1.0 NEAR > MAX 0.1
    }

    #[test]
    #[should_panic(expected = "must cover a thought")]
    fn guest_minimum_must_cover_a_thought() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.set_guest_min_price(U128(1)); // 1 yocto < the 0.002 thought cost
    }

    #[test]
    fn a_retuned_thought_cost_is_charged_and_locked_on_the_next_think() {
        // Hatch under the contract account so it is the owner and may think().
        testing_env!(admin_ctx(NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Echo".to_string(), None); // balance 0.1, cost default 0.002
        let new_cost = crate::state::ONE_NEAR / 250; // 0.004
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        c.set_thought_cost(U128(new_cost));
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
        assert_eq!(
            c.get_mind(0).unwrap().balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR / 10 - new_cost)
        );
        // the in-flight thought locked in the new cost
        assert_eq!(c.pending.get(&0).unwrap().cost_paid, new_cost);
    }

    #[test]
    fn a_refund_returns_the_cost_locked_at_spend_time_not_the_new_one() {
        testing_env!(admin_ctx(NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Echo".to_string(), None); // balance 0.1
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string()); // pays the default 0.002, locked in Pending
        let locked = c.pending.get(&0).unwrap().cost_paid;
        c.set_thought_cost(U128(crate::state::ONE_NEAR / 250)); // raise to 0.004 while in flight
        // a timeout refunds exactly the locked 0.002 -> balance back to 0.1, not 0.102
        c.finalize_thought(0, Err(()), 10, locked);
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_millinear(100));
    }

    #[test]
    fn revive_wakes_an_asleep_mind_with_an_80_20_split() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_yoctonear(0), false, 500)); // asleep, empty
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build()); // pay the revive price (>= 0.1)
        c.revive(0);
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance, NearToken::from_yoctonear(crate::state::ONE_NEAR * 80 / 100)); // 0.8 -> food
        assert_eq!(m.asleep_since, 0); // awake again (0.8 >> one thought)
        assert_eq!(
            c.treasury_balance(),
            NearToken::from_yoctonear(crate::state::ONE_NEAR * 20 / 100) // 0.2 -> treasury
        );
    }

    #[test]
    #[should_panic(expected = "no need to revive")]
    fn revive_rejects_an_awake_mind() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0)); // awake
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        c.revive(0);
    }

    #[test]
    #[should_panic(expected = "memorial")]
    fn revive_rejects_a_ghost() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_yoctonear(0), true, 500)); // ghost
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        c.revive(0);
    }

    #[test]
    #[should_panic(expected = "revive price")]
    fn revive_below_the_price_panics() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_yoctonear(0), false, 500));
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(50)).build()); // 0.05 < 0.1
        c.revive(0);
    }

    // --- governance invariants ---

    #[test]
    #[should_panic(expected = "raise the guest minimum first")]
    fn raising_thought_cost_above_what_a_min_guest_covers_is_rejected() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default(); // guest_min 0.01 -> a guest leaves the owner 0.009
        // 0.009 is under the 0.1 ceiling but not below what a minimum guest pays the owner.
        c.set_thought_cost(U128(crate::state::ONE_NEAR * 9 / 1000));
    }

    #[test]
    #[should_panic(expected = "after the 10%")]
    fn a_guest_minimum_equal_to_the_thought_cost_is_rejected() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default(); // thought_cost 0.002
        // p == cost looks fine on the gross deposit, but the owner keeps only 0.0018 of it.
        c.set_guest_min_price(U128(economy::THOUGHT_COMPUTE_COST));
    }

    #[test]
    fn raising_thought_cost_after_raising_the_guest_minimum_is_allowed() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        // Lift the guest minimum first, then the thought cost may follow.
        c.set_guest_min_price(U128(crate::state::ONE_NEAR / 10)); // 0.1 -> guest leaves the owner 0.09
        c.set_thought_cost(U128(crate::state::ONE_NEAR * 8 / 1000)); // 0.008 < 0.09, ok now
        assert_eq!(
            c.params().thought_cost,
            NearToken::from_yoctonear(crate::state::ONE_NEAR * 8 / 1000)
        );
    }

    #[test]
    #[should_panic(expected = "enough to wake")]
    fn a_revive_price_too_low_to_wake_is_rejected() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.set_revive_price(U128(1)); // 1 yocto -> wakes nobody
    }

    #[test]
    #[should_panic(expected = "too small to wake")]
    fn revive_reverts_when_the_deposit_cannot_wake_the_mind() {
        let mut c = Contract::default();
        // Force the misconfigured edge directly (the setters would reject it).
        c.thought_cost = crate::state::ONE_NEAR / 10; // 0.1
        c.revive_price = crate::state::ONE_NEAR / 100; // 0.01
        c.minds.insert(0, make_mind(NearToken::from_yoctonear(0), false, 500)); // asleep, empty
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build()); // 0.01 deposit
        c.revive(0); // to_mind 0.008 < 0.1 -> revert, no money taken
    }

    #[test]
    #[should_panic(expected = "cannot afford a thought")]
    fn a_guest_chat_reverts_when_the_mind_cannot_afford_the_thought() {
        let mut c = Contract::default();
        c.thought_cost = crate::state::ONE_NEAR / 10; // 0.1 (direct, bypassing the invariant guard)
        c.minds.insert(
            0,
            make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000), false, 0), // awake, 0.001
        );
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build()); // guest pays 0.01
        // credit leaves the Mind 0.008 < 0.1, so no thought is charged -> chat must revert,
        // never parking a thought that a later timeout would refund as minted NEAR.
        let _ = c.chat(0, "hi".to_string());
    }

    // --- idle metabolism (neglect makes a Mind hungry over time) ---

    #[test]
    fn neglect_drains_an_awake_mind_over_time() {
        let mut c = Contract::default(); // idle rate 10/day, thought cost 0.002
        let mut m = make_mind(NearToken::from_near(1), false, 0);
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        testing_env!(ctx_at("keeper.near", crate::state::NS_PER_DAY).build()); // one day later
        c.settle(0);
        // 10 autonomous thoughts * 0.002 = 0.02 drained
        assert_eq!(
            c.get_mind(0).unwrap().balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR - crate::state::ONE_NEAR * 2 / 100)
        );
        assert_eq!(c.get_mind(0).unwrap().asleep_since, 0); // still well awake
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(20)); // the burnt food goes to the treasury
    }

    #[test]
    fn a_starving_mind_sends_only_what_it_had_to_the_treasury() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_millinear(5), false, 0);
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        testing_env!(ctx_at("keeper.near", 10 * crate::state::NS_PER_DAY).build()); // owes 0.2, has 0.005
        c.settle(0);
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(5));
    }

    // --- the thought cost pays the brain; the treasury can be withdrawn ---
    fn hatched_with_worker() -> Contract {
        testing_env!(ctx_on("hm.near", NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.add_responder("worker.near".parse().unwrap());
        testing_env!(ctx_on("alice.near", NearToken::from_near(1)).build());
        c.hatch_mind("Rue".to_string(), None); // treasury 0.65
        c
    }

    #[test]
    fn an_approved_responder_earns_the_thought_cost() {
        let mut c = hatched_with_worker();
        testing_env!(ctx_on("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
        answered_by().insert(0, "worker.near".parse().unwrap());
        c.resolve_thought(0, 0, Ok("hello".to_string()), 1);
        assert_eq!(c.responder_earnings_of("worker.near".parse().unwrap()), NearToken::from_millinear(2));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(651)); // only the 10% guest share
        assert!(answered_by().get(&0).is_none(), "the record is cleared once resolved");

        testing_env!(ctx_on("worker.near", NearToken::from_yoctonear(0)).build());
        c.claim_responder_earnings();
        assert_eq!(c.responder_earnings_of("worker.near".parse().unwrap()), NearToken::from_yoctonear(0));
    }

    #[test]
    fn a_keeper_answering_their_own_mind_cannot_take_its_food() {
        let mut c = hatched_with_worker();
        testing_env!(ctx_on("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
        answered_by().insert(0, "alice.near".parse().unwrap());
        c.resolve_thought(0, 0, Ok("me".to_string()), 1);
        assert_eq!(c.responder_earnings_of("alice.near".parse().unwrap()), NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(652)); // the 0.002 went to the treasury
    }

    #[test]
    fn a_removed_responder_no_longer_earns() {
        let mut c = hatched_with_worker();
        testing_env!(ctx_on("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
        testing_env!(ctx_on("hm.near", NearToken::from_yoctonear(0)).build());
        c.remove_responder("worker.near".parse().unwrap());
        answered_by().insert(0, "worker.near".parse().unwrap());
        c.resolve_thought(0, 0, Ok("hello".to_string()), 1);
        assert_eq!(c.responder_earnings_of("worker.near".parse().unwrap()), NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(652));
    }

    #[test]
    fn a_timed_out_thought_pays_no_one_and_refunds_the_mind() {
        let mut c = hatched_with_worker();
        testing_env!(ctx_on("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
        c.resolve_thought(0, 0, Err(()), 1);
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_millinear(100));
        assert_eq!(c.responder_earnings_of("worker.near".parse().unwrap()), NearToken::from_yoctonear(0));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650));
    }

    fn admin_with_balance(near: u128) -> VMContextBuilder {
        let mut b = ctx_on("hm.near", NearToken::from_yoctonear(0));
        b.account_balance(NearToken::from_near(near)).storage_usage(100_000); // 1 NEAR of storage stake
        b
    }

    #[test]
    fn the_contract_account_withdraws_part_of_the_treasury() {
        let mut c = hatched_with_worker();
        testing_env!(admin_with_balance(10).build());
        let _ = c.withdraw_treasury("team.near".parse().unwrap(), U128(crate::state::ONE_NEAR / 2));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(150));
    }

    #[test]
    fn a_failed_withdrawal_returns_to_the_treasury() {
        let mut c = hatched_with_worker();
        testing_env!(admin_with_balance(10).build());
        let _ = c.withdraw_treasury("team.near".parse().unwrap(), U128(crate::state::ONE_NEAR / 2));
        c.on_treasury_withdrawn(U128(crate::state::ONE_NEAR / 2), Err(PromiseError::Failed));
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650));
        c.on_treasury_withdrawn(U128(1), Ok(())); // a successful transfer changes nothing
        assert_eq!(c.treasury_balance(), NearToken::from_millinear(650));
    }

    #[test]
    #[should_panic(expected = "only the contract account")]
    fn a_stranger_cannot_withdraw_the_treasury() {
        let mut c = hatched_with_worker();
        testing_env!(ctx_on("mallory.near", NearToken::from_yoctonear(0)).build());
        let _ = c.withdraw_treasury("mallory.near".parse().unwrap(), U128(1));
    }

    #[test]
    #[should_panic(expected = "amount exceeds the treasury")]
    fn no_more_than_the_treasury_can_be_withdrawn() {
        let mut c = hatched_with_worker();
        testing_env!(admin_with_balance(10).build());
        let _ = c.withdraw_treasury("team.near".parse().unwrap(), U128(crate::state::ONE_NEAR));
    }

    #[test]
    #[should_panic(expected = "too little to cover the contract's storage")]
    fn a_withdrawal_must_leave_the_storage_stake_covered() {
        let mut c = hatched_with_worker();
        testing_env!(admin_with_balance(2).build()); // 2 NEAR - 0.5 < 1 stake + 1 float
        let _ = c.withdraw_treasury("team.near".parse().unwrap(), U128(crate::state::ONE_NEAR / 2));
    }

    #[test]
    fn a_neglected_mind_starves_to_sleep_in_about_ten_days() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 5), false, 0); // 0.2 NEAR
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        testing_env!(ctx_at("keeper.near", 10 * crate::state::NS_PER_DAY).build()); // ten untouched days
        c.settle(0);
        let after = c.get_mind(0).unwrap();
        assert_eq!(after.balance, NearToken::from_yoctonear(0));
        assert_eq!(after.asleep_since, 10 * crate::state::NS_PER_DAY); // fell asleep
    }

    #[test]
    fn metabolism_leaves_asleep_and_ghost_minds_untouched() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 500)); // asleep
        c.minds.insert(1, make_mind(NearToken::from_near(1), true, 0)); // ghost
        testing_env!(ctx_at("keeper.near", 100 * crate::state::NS_PER_DAY).build());
        c.settle(0);
        c.settle(1);
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_near(1));
        assert_eq!(c.get_mind(1).unwrap().balance, NearToken::from_near(1));
    }

    #[test]
    fn feeding_a_starved_mind_resets_its_metabolism_clock() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 5), false, 0); // 0.2
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        // owner feeds 1.0 long after neglect would have starved it
        testing_env!(ctx_at("alice.near", 100 * crate::state::NS_PER_DAY)
            .attached_deposit(NearToken::from_near(1))
            .build());
        c.feed(0);
        let after = c.get_mind(0).unwrap();
        assert_eq!(after.asleep_since, 0); // awake again
        assert_eq!(after.last_metabolism_ts, 100 * crate::state::NS_PER_DAY); // clock reset, no back-charge
        // starved to 0 by settle, then +0.95 of the 1.0 feed
        assert_eq!(after.balance, NearToken::from_yoctonear(crate::state::ONE_NEAR * 95 / 100));
    }

    #[test]
    fn live_views_show_decay_before_it_is_settled_on_chain() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_near(1), false, 0);
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        testing_env!(ctx_at("viewer.near", crate::state::NS_PER_DAY).build());
        // read-only: effective balance is down 0.02, but the STORED balance is untouched
        assert_eq!(
            c.live_balance(0).unwrap(),
            NearToken::from_yoctonear(crate::state::ONE_NEAR - crate::state::ONE_NEAR * 2 / 100)
        );
        assert_eq!(c.live_state(0).as_deref(), Some("full")); // 0.98 is still Full
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_near(1)); // not yet persisted
    }

    #[test]
    #[should_panic(expected = "asleep — feed it")]
    fn think_settles_metabolism_first_so_a_starved_mind_cannot_think() {
        testing_env!(admin_ctx(NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Dust".to_string(), None); // owner hm.near, balance 1.0, clock at ts 0
        // 500 untouched days later the owner tries to think — metabolism has starved it
        let mut b = VMContextBuilder::new();
        b.current_account_id("hm.near".parse().unwrap())
            .predecessor_account_id("hm.near".parse().unwrap())
            .block_timestamp(500 * crate::state::NS_PER_DAY);
        testing_env!(b.build());
        let _ = c.think(0, "are you there?".to_string());
    }

    #[test]
    fn the_contract_account_can_retune_the_idle_rate() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        c.set_idle_rate(3);
        assert_eq!(c.params().idle_rate_per_day, 3);
    }

    #[test]
    fn live_state_predicts_sleep_below_one_thought() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 400), false, 0); // 0.0025
        m.last_metabolism_ts = 0;
        c.minds.insert(0, m);
        // one per_thought interval later, one autonomous thought (0.002) drains -> eff 0.0005 (< cost)
        testing_env!(ctx_at("viewer.near", crate::state::NS_PER_DAY / 10).build());
        assert_eq!(c.live_state(0).as_deref(), Some("asleep")); // view predicts the sleep
        assert_eq!(c.get_mind(0).unwrap().asleep_since, 0); // not yet persisted
        c.settle(0); // settle at the same now persists exactly that
        assert_eq!(c.mind_state(0).as_deref(), Some("asleep"));
    }

    #[test]
    fn a_timeout_refund_wake_resets_the_metabolism_clock() {
        let mut c = Contract::default();
        let mut m = make_mind(NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000), false, 500); // 0.001, asleep
        m.last_metabolism_ts = 100; // stale clock from before it slept
        c.minds.insert(0, m);
        // a timed-out thought refunds the 0.002 it paid, waking the Mind long after it slept
        c.finalize_thought(0, Err(()), 7 * crate::state::NS_PER_DAY, economy::THOUGHT_COMPUTE_COST);
        let after = c.get_mind(0).unwrap();
        assert_eq!(after.asleep_since, 0); // awake
        assert_eq!(
            after.balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000 + economy::THOUGHT_COMPUTE_COST)
        ); // 0.003
        assert_eq!(after.last_metabolism_ts, 7 * crate::state::NS_PER_DAY); // reset to now, not 100
        // a settle at the same instant must NOT back-charge the long sleep gap
        testing_env!(ctx_at("keeper.near", 7 * crate::state::NS_PER_DAY).build());
        c.settle(0);
        assert_eq!(
            c.get_mind(0).unwrap().balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR / 1000 + economy::THOUGHT_COMPUTE_COST)
        ); // unchanged — no retroactive charge
    }

    // --- the no-withdraw invariant ---
    #[test]
    fn claiming_earnings_never_touches_the_mind_balance() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        // a guest chat accrues owner_unclaimed
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
        c.resolve_thought(0, 0, Ok("hello".to_string()), 1); // reply delivered -> escrow splits
        let balance_before = c.get_mind(0).unwrap().balance;

        let taken = c.take_owner_earnings(0);

        assert_eq!(taken, NearToken::from_millinear(9)); // the owner's 90%
        assert_eq!(c.get_mind(0).unwrap().owner_unclaimed, NearToken::from_yoctonear(0));
        assert_eq!(c.get_mind(0).unwrap().balance, balance_before); // Mind's food untouched
    }

    // --- appearance / svg_for ---
    #[test]
    fn appearance_follows_balance_and_flags() {
        assert_eq!(make_mind(NearToken::from_near(1), false, 0).appearance(), Appearance::Full);
        assert_eq!(make_mind(NearToken::from_millinear(10), false, 0).appearance(), Appearance::Hungry);
        assert_eq!(make_mind(NearToken::from_millinear(4), false, 0).appearance(), Appearance::Starving);
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

    #[test]
    fn svg_for_bare_is_transparent_current_state_art() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0)); // full
        let framed = c.svg_for(0).expect("some");
        let bare = c.svg_for_bare(0).expect("some");
        assert!(bare.trim_start().starts_with("<svg"));
        // The framed art (wallet image) sits on the tone's tile; the bare variant is
        // transparent so the site can float the creature in its own scene (glossy.rs).
        assert!(framed.contains("<rect"), "framed art paints a background");
        assert!(!bare.contains("<rect"), "bare art is transparent");
        assert_eq!(c.svg_for_bare(99), None);
    }

    // --- NEP-171 metadata + enumeration ---
    #[test]
    fn nft_metadata_names_the_collection() {
        let c = Contract::default();
        let m = c.nft_metadata();
        assert_eq!(m.name, "Hungry Minds");
        assert_eq!(m.symbol, "MIND");
        assert_eq!(m.spec, "nft-1.0.0");
        let icon = m.icon.expect("the collection has an icon");
        assert!(icon.starts_with("data:image/svg+xml;base64,"));
    }

    #[test]
    fn payout_gives_the_whole_sale_to_the_owner() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        let p = c.nft_payout("0".into(), U128(5_000), Some(10));
        assert_eq!(p.payout.len(), 1);
        assert_eq!(p.payout.get(&"alice.near".parse::<AccountId>().unwrap()), Some(&U128(5_000)));
    }

    #[test]
    fn transfer_payout_moves_the_token_and_pays_the_seller() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        let p = c.nft_transfer_payout("bob.near".parse().unwrap(), "0".into(), None, None, U128(7), None);
        assert_eq!(p.payout.get(&"alice.near".parse::<AccountId>().unwrap()), Some(&U128(7)));
        assert_eq!(c.nft_token("0".into()).unwrap().owner_id.as_str(), "bob.near");
    }

    #[test]
    #[should_panic(expected = "only the token owner or an approved account")]
    fn a_stranger_cannot_transfer_payout() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("eve.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer_payout("eve.near".parse().unwrap(), "0".into(), None, None, U128(7), None);
    }

    #[test]
    fn nft_token_carries_owner_title_and_live_media() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        let tok = c.nft_token("0".to_string()).expect("token");
        assert_eq!(tok.token_id, "0");
        assert_eq!(tok.owner_id, "alice.near".parse::<AccountId>().unwrap());
        let md = tok.metadata.expect("metadata");
        assert_eq!(md.title.as_deref(), Some("Rue"));
        assert!(md.media.unwrap().starts_with("data:image/svg+xml;base64,"));
        assert!(c.nft_token("99".to_string()).is_none());
        assert!(c.nft_token("not-a-number".to_string()).is_none());
    }

    #[test]
    fn enumeration_counts_and_filters_by_owner() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("A".to_string(), None); // 0 alice
        c.hatch_mind("B".to_string(), None); // 1 alice
        testing_env!(ctx_from("bob.near", NearToken::from_near(1)).build());
        c.hatch_mind("C".to_string(), None); // 2 bob

        assert_eq!(c.nft_total_supply(), U128(3));
        assert_eq!(c.nft_supply_for_owner("alice.near".parse().unwrap()), U128(2));
        assert_eq!(c.nft_tokens(None, None).len(), 3);
        let alices = c.nft_tokens_for_owner("alice.near".parse().unwrap(), None, None);
        assert_eq!(alices.len(), 2);
        assert!(alices
            .iter()
            .all(|t| t.owner_id == "alice.near".parse::<AccountId>().unwrap()));
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

    #[test]
    fn reaping_credits_the_storage_rebate_to_the_owner_to_claim() {
        let asleep = 1_000_000_000u64;
        let mut c = Contract::default();
        c.minds
            .insert(0, make_mind(NearToken::from_yoctonear(0), false, asleep));
        testing_env!(ctx_at("keeper.near", asleep + crate::state::GHOST_AFTER_NS).build());
        c.reap(0);
        // 0.25 NEAR reserve becomes claimable (pull pattern), the Mind's balance untouched.
        assert_eq!(c.get_mind(0).unwrap().owner_unclaimed, NearToken::from_millinear(250));
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_yoctonear(0));
    }

    // --- nft_transfer: sold whole ---
    #[test]
    fn transfer_carries_balance_and_memory_and_settles_the_old_owners_cut() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None); // alice owns token 0
        // a guest chat accrues alice's 90% and adds to the Mind's memory (thought_count)
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
        c.resolve_thought(0, 0, Ok("hello".to_string()), 1); // reply delivered -> escrow splits
        let balance = c.get_mind(0).unwrap().balance;
        let thoughts = c.get_mind(0).unwrap().thought_count;
        assert!(c.get_mind(0).unwrap().owner_unclaimed.as_yoctonear() > 0);

        // alice sells to carol with exactly 1 yocto
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);

        let m = c.get_mind(0).unwrap();
        assert_eq!(m.owner, "carol.near".parse::<AccountId>().unwrap()); // new owner
        assert_eq!(m.balance, balance); // the Mind's food travels, untouched
        assert_eq!(m.thought_count, thoughts); // memory travels
        assert_eq!(m.owner_unclaimed, NearToken::from_yoctonear(0)); // alice's cut settled out
    }

    #[test]
    #[should_panic(expected = "owner")]
    fn only_the_owner_can_transfer() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "yocto")]
    fn transfer_requires_exactly_one_yocto() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(0)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);
    }

    // --- nft_transfer_call ---
    #[test]
    fn should_revert_only_when_receiver_returns_or_fails() {
        assert!(!should_revert(Ok(false))); // receiver kept it
        assert!(should_revert(Ok(true))); // receiver returned it
        assert!(should_revert(Err(()))); // receiver call failed
    }

    #[test]
    fn transfer_call_hands_the_token_over_before_the_receiver_runs() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        let _ = c.nft_transfer_call(
            "market.near".parse().unwrap(),
            "0".to_string(),
            None,
            None,
            "list".to_string(),
        );
        // Ownership moves synchronously; nft_resolve_transfer may revert it later.
        assert_eq!(c.get_mind(0).unwrap().owner, "market.near".parse::<AccountId>().unwrap());
    }

    // --- NEP-178: approval management ---

    /// Hatch token 0 owned by alice and return the contract. Leaves env as alice.
    fn hatched() -> Contract {
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string(), None);
        c
    }

    #[test]
    fn approve_lets_an_approved_account_transfer() {
        let mut c = hatched();
        // alice approves a marketplace (deposit covers storage; excess refunded)
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        let ret = c.nft_approve("0".to_string(), "market.near".parse().unwrap(), None);
        assert!(ret.is_none(), "no msg -> no nft_on_approve promise");
        assert!(c.nft_is_approved("0".to_string(), "market.near".parse().unwrap(), None));

        // the market moves the token on alice's behalf
        testing_env!(ctx_from("market.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);
        assert_eq!(c.get_mind(0).unwrap().owner, "carol.near".parse::<AccountId>().unwrap());
    }

    #[test]
    fn approvals_get_incrementing_ids_checked_by_is_approved() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "a.near".parse().unwrap(), None);
        c.nft_approve("0".to_string(), "b.near".parse().unwrap(), None);

        assert!(c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), Some(1)));
        assert!(c.nft_is_approved("0".to_string(), "b.near".parse().unwrap(), Some(2)));
        assert!(!c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), Some(2)));
        assert!(c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), None));
        assert!(!c.nft_is_approved("0".to_string(), "nobody.near".parse().unwrap(), None));
        assert!(!c.nft_is_approved("99".to_string(), "a.near".parse().unwrap(), None));
    }

    #[test]
    fn reapproving_updates_the_id() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "a.near".parse().unwrap(), None); // id 1
        c.nft_approve("0".to_string(), "a.near".parse().unwrap(), None); // id 2
        assert!(!c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), Some(1)));
        assert!(c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), Some(2)));
    }

    #[test]
    #[should_panic(expected = "only the owner")]
    fn non_owner_cannot_approve() {
        let mut c = hatched();
        testing_env!(ctx_from("mallory.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "mallory.near".parse().unwrap(), None);
    }

    #[test]
    fn revoke_removes_one_approval() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "a.near".parse().unwrap(), None);
        c.nft_approve("0".to_string(), "b.near".parse().unwrap(), None);

        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        c.nft_revoke("0".to_string(), "a.near".parse().unwrap());
        assert!(!c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), None));
        assert!(c.nft_is_approved("0".to_string(), "b.near".parse().unwrap(), None));
    }

    #[test]
    fn revoke_all_clears_every_approval() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "a.near".parse().unwrap(), None);
        c.nft_approve("0".to_string(), "b.near".parse().unwrap(), None);

        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        c.nft_revoke_all("0".to_string());
        assert!(!c.nft_is_approved("0".to_string(), "a.near".parse().unwrap(), None));
        assert!(!c.nft_is_approved("0".to_string(), "b.near".parse().unwrap(), None));
        // the token view reports an empty approval set
        assert!(c.nft_token("0".to_string()).unwrap().approved_account_ids.unwrap().is_empty());
    }

    #[test]
    fn a_transfer_clears_approvals() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "market.near".parse().unwrap(), None);

        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);
        // the old approval does not carry to the new owner
        assert!(!c.nft_is_approved("0".to_string(), "market.near".parse().unwrap(), None));
    }

    #[test]
    #[should_panic(expected = "approval_id does not match")]
    fn a_stale_approval_id_is_rejected() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "market.near".parse().unwrap(), None); // id 1

        testing_env!(ctx_from("market.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), Some(999), None);
    }

    #[test]
    fn nft_token_surfaces_approvals() {
        let mut c = hatched();
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(10)).build());
        c.nft_approve("0".to_string(), "market.near".parse().unwrap(), None);
        let ids = c.nft_token("0".to_string()).unwrap().approved_account_ids.unwrap();
        assert_eq!(ids.get(&"market.near".parse::<AccountId>().unwrap()), Some(&1));
    }

    #[test]
    #[should_panic(expected = "deposit")]
    fn approve_without_enough_deposit_is_rejected() {
        let mut c = hatched();
        // 1 yocto is far below the storage cost of a new approval
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(1)).build());
        c.nft_approve("0".to_string(), "market.near".parse().unwrap(), None);
    }

    // --- leaderboard ---

    fn ranked_mind(name: &str, thoughts: u64, balance: NearToken, ghost: bool) -> Mind {
        let mut m = make_mind(balance, ghost, 0);
        m.name = name.to_string();
        m.thought_count = thoughts;
        m
    }

    #[test]
    fn leaderboard_ranks_living_minds_by_thoughts_and_respects_limit() {
        let mut c = Contract::default();
        c.minds.insert(0, ranked_mind("Alpha", 5, NearToken::from_near(1), false));
        c.minds.insert(1, ranked_mind("Beta", 20, NearToken::from_near(1), false));
        c.minds.insert(2, ranked_mind("Gamma", 10, NearToken::from_near(1), false));
        c.minds.insert(3, ranked_mind("Wraith", 99, NearToken::from_near(1), true)); // ghost

        let top2 = c.leaderboard(Some(2));
        assert_eq!(top2.len(), 2);
        assert_eq!(top2[0].name, "Beta"); // 20 thoughts
        assert_eq!(top2[0].id, 1);
        assert_eq!(top2[1].name, "Gamma"); // 10 thoughts

        // ghosts are dead and never rank, however many thoughts they had
        let all = c.leaderboard(None);
        assert_eq!(all.len(), 3);
        assert!(!all.iter().any(|r| r.name == "Wraith"));
        assert_eq!(all.last().unwrap().name, "Alpha"); // fewest thoughts last
    }

    #[test]
    fn leaderboard_breaks_ties_by_balance() {
        let mut c = Contract::default();
        c.minds.insert(0, ranked_mind("Lean", 7, NearToken::from_millinear(100), false));
        c.minds.insert(1, ranked_mind("Plump", 7, NearToken::from_near(2), false));
        let board = c.leaderboard(None);
        assert_eq!(board[0].name, "Plump"); // same thoughts, more food wins the tie
    }
}
