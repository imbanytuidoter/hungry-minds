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
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::Token;
use near_sdk::json_types::U128;
use near_sdk::store::IterableMap;
use near_sdk::{
    env, ext_contract, near, AccountId, Gas, GasWeight, NearToken, Promise, PromiseError,
    PromiseOrValue, YieldId,
};
use std::collections::{BTreeMap, HashMap};

/// Gas reserved for the thinking callback when the reply (or timeout) comes back.
const GAS_FOR_THINK_CALLBACK: Gas = Gas::from_tgas(10);
/// Longest prompt a Mind will accept — bounds request storage and abuse.
const MAX_PROMPT_LEN: usize = 500;
/// Longest reply stored on a Mind. `respond` is permissionless (the pull model lets any
/// worker resume a thought), so a stored reply is capped to bound storage-griefing.
const MAX_REPLY_LEN: usize = 1000;

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
    /// 0 = awake; otherwise the block timestamp it fell asleep.
    pub asleep_since: u64,
    pub thought_count: u64,
    pub ghost: bool,
    /// Owner's unclaimed 20% guest-chat cut (the only money the owner may take).
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
/// off-chain worker (OutLayer TEE -> NEAR AI) to resume it with a signed reply.
#[near(serializers = [borsh])]
pub struct Pending {
    pub mind_id: u64,
    pub prompt: String,
    pub by_owner: bool,
    pub yield_id: YieldId,
    /// The thought cost locked in at spend time, so a timeout refunds exactly what the
    /// Mind paid even if the governable `thought_cost` was retuned while this was in flight.
    pub cost_paid: u128,
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
    /// no separate owner field to initialize. Flag #1: `thought_cost` must track real
    /// inference price, so it lives here, not frozen in code.
    thought_cost: u128,
    guest_min_price: u128,
    revive_price: u128,
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
        }
    }
}

// Internal, promise-free helpers (unit-tested directly; the public methods below
// orchestrate these and the OutLayer dispatch).
impl Contract {
    /// Credit a guest's pay-to-chat (70% Mind / 20% owner-unclaimed / 10% treasury)
    /// and spend the one thought the reply will cost.
    /// Returns whether the triggered thought was actually charged. The caller MUST NOT park a
    /// thought when this is false, or a later timeout would refund a cost that was never
    /// debited (minting NEAR). With the guest-covers-a-thought invariant enforced by the
    /// governance setters this is always true, but chat asserts it as defence in depth.
    fn credit_guest_payment(&mut self, id: u64, deposit: u128, now: u64, cost: u128) -> bool {
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
        mind.spend_one_thought(now, cost)
    }

    /// Build the NEP-171 `Token` view for a Mind, with live on-chain SVG media.
    fn as_token(&self, id: u64, mind: &Mind) -> Token {
        let svg = art::render(&art::Face {
            traits: mind.traits,
            appearance: mind.appearance(),
        });
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
            issued_at: Some(mind.born_ts.to_string()),
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

    /// Take and zero the owner's accrued 20% cut. NEVER touches the Mind's balance.
    fn take_owner_earnings(&mut self, id: u64) -> NearToken {
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        let amount = mind.owner_unclaimed;
        mind.owner_unclaimed = NearToken::from_yoctonear(0);
        amount
    }

    /// Park a yielded promise for a thought and store the request so the off-chain worker
    /// (OutLayer TEE -> NEAR AI) can pick it up and resume it with a reply. Returns the
    /// yielded promise (the caller's transaction pauses here until a reply or the 200-block
    /// timeout). The thought's cost has already been spent by the caller.
    fn park_thought(&mut self, mind_id: u64, prompt: String, by_owner: bool, cost_paid: u128) -> Promise {
        let rid = self.next_request;
        self.next_request += 1;
        let args = near_sdk::serde_json::json!({ "mind_id": mind_id, "request_id": rid })
            .to_string()
            .into_bytes();
        let (promise, yield_id) =
            Promise::new_yield("on_thought", args, GAS_FOR_THINK_CALLBACK, GasWeight::default());
        self.pending.insert(
            rid,
            Pending { mind_id, prompt, by_owner, yield_id, cost_paid },
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
                // Cap the stored reply (char-safe) — respond is permissionless, so this
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
            let mind = self.minds.get(&id).expect("no such Mind");
            let by_owner = *sender == mind.owner;
            if !by_owner {
                // NEP-178: an approved account may transfer on the owner's behalf.
                match mind.approvals.get(sender) {
                    None => env::panic_str("only the token owner or an approved account may transfer it"),
                    Some(actual) => assert!(
                        approval_id.is_none() || approval_id.as_ref() == Some(actual),
                        "approval_id does not match"
                    ),
                }
            }
            assert!(*receiver_id != mind.owner, "cannot transfer a Mind to its current owner");
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
        self.minds.get(&id).map(|m| {
            art::render(&art::Face {
                traits: m.traits,
                appearance: m.appearance(),
            })
        })
    }

    /// Same creature, same live state, but with no background window — for the web
    /// habitat where the Mind floats in its own light beam. The chain still draws it.
    pub fn svg_for_bare(&self, id: u64) -> Option<String> {
        self.minds.get(&id).map(|m| {
            art::render_bare(&art::Face {
                traits: m.traits,
                appearance: m.appearance(),
            })
        })
    }

    // --- NEP-171 / NEP-177 / NEP-181: the wallet + indexer surface ---

    /// Collection-level metadata (NEP-177).
    pub fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Hungry Minds".to_string(),
            symbol: "MIND".to_string(),
            icon: None,
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

    /// Hatch a new Mind. Payable: >= 2 NEAR. Rolls traits from block randomness,
    /// seeds the Mind's balance, routes the rest per the mint split, and returns the id.
    #[payable]
    pub fn hatch_mind(&mut self, name: String) -> u64 {
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit >= economy::MINT_PRICE, "hatch needs at least 2 NEAR");
        // Bound the one free-form field so a long name can't lock more storage stake
        // than the 0.25 NEAR reserve ever refunds.
        assert!(!name.is_empty() && name.len() <= 32, "name must be 1..=32 bytes");
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
        let split = economy::feed_split(env::attached_deposit().as_yoctonear());
        let cost = self.thought_cost;
        let mind = self.minds.get_mut(&id).expect("no such Mind");
        assert!(!mind.ghost, "a ghost cannot be fed");
        mind.balance = mind
            .balance
            .saturating_add(NearToken::from_yoctonear(split.to_mind));
        if mind.asleep_since != 0 && mind.balance.as_yoctonear() >= cost {
            mind.asleep_since = 0; // woke up
        }
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
    }

    /// Instant paid comeback for an *asleep* Mind: attach >= `revive_price`; the split sends
    /// the premium share to treasury and the rest into the Mind's locked food, waking it at
    /// once. This is never the only way back — `feed`ing a little, or letting guests `chat`,
    /// also wakes a Mind for free (just slower) — so revive is a convenience, not a ransom.
    /// A ghost (reaped after the long sleep) is a permanent memorial and is NOT revived here;
    /// whether ghosts should ever return is a deliberate open design question, left out of code.
    #[payable]
    pub fn revive(&mut self, id: u64) {
        let deposit = env::attached_deposit().as_yoctonear();
        assert!(deposit >= self.revive_price, "revive needs at least the revive price");
        let cost = self.thought_cost;
        let split = economy::revive_split(deposit);
        {
            let mind = self.minds.get_mut(&id).expect("no such Mind");
            assert!(!mind.ghost, "a ghost is a memorial and cannot be revived");
            assert!(mind.asleep_since != 0, "this Mind is awake — no need to revive");
            mind.balance = mind
                .balance
                .saturating_add(NearToken::from_yoctonear(split.to_mind));
            // Revive must deliver its one promised effect: never take the deposit and leave
            // the Mind asleep. If the deposit cannot lift it to one thought, revert entirely.
            assert!(
                mind.balance.as_yoctonear() >= cost,
                "revive deposit too small to wake this Mind — attach more"
            );
            mind.asleep_since = 0; // guaranteed awake
        }
        self.treasury = self
            .treasury
            .saturating_add(NearToken::from_yoctonear(split.to_treasury));
    }

    /// The owner talks to their own Mind: spends one thought from its balance.
    pub fn think(&mut self, id: u64, prompt: String) -> Promise {
        assert!(prompt.len() <= MAX_PROMPT_LEN, "prompt too long");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let cost = self.thought_cost;
        {
            let mind = self.minds.get_mut(&id).expect("no such Mind");
            assert_eq!(caller, mind.owner, "only the owner can use think()");
            assert!(!mind.ghost, "this Mind is a ghost — revive it first");
            // The Mind pays for the thought up front; a timeout refunds it (finalize_thought).
            assert!(mind.spend_one_thought(now, cost), "this Mind is asleep — feed it");
        }
        self.park_thought(id, prompt, true, cost)
    }

    /// A stranger pays to talk to a public Mind (70/20/10) and it thinks a reply.
    #[payable]
    pub fn chat(&mut self, id: u64, prompt: String) -> Promise {
        assert!(prompt.len() <= MAX_PROMPT_LEN, "prompt too long");
        let caller = env::predecessor_account_id();
        let now = env::block_timestamp();
        let deposit = env::attached_deposit().as_yoctonear();
        let cost = self.thought_cost;
        // A guest must cover the thought they trigger, or a free-rider could drain the
        // Mind's food one thought at a time for only gas. See `guest_min_price`.
        assert!(deposit >= self.guest_min_price, "chat deposit below the guest minimum");
        {
            let mind = self.minds.get(&id).expect("no such Mind");
            assert!(caller != mind.owner, "use think() for your own Mind");
            assert!(!mind.ghost, "this Mind is a ghost");
            assert_eq!(mind.asleep_since, 0, "this Mind is asleep — only the owner can feed it");
        }
        let spent = self.credit_guest_payment(id, deposit, now, cost);
        // Never park a thought that was not actually charged (else a timeout would refund an
        // undebited cost). Guaranteed true by the guest-covers-a-thought invariant; asserted
        // so the money logic is self-protecting even if that invariant ever regresses.
        assert!(spent, "this Mind cannot afford a thought right now");
        self.park_thought(id, prompt, false, cost)
    }

    /// The off-chain worker (OutLayer TEE -> NEAR AI) returns a reply here, resuming the
    /// parked thought. The reply's TEE signature is verified OFF-CHAIN (EIP-191) for the
    /// "verified ✓" badge; the contract never gates money on a signature.
    pub fn respond(&mut self, request_id: u64, reply: String) {
        let p = self.pending.get(&request_id).expect("no such pending thought");
        // Resume the parked promise; on_thought then stores the reply and clears the request.
        let _ = p
            .yield_id
            .resume(near_sdk::serde_json::to_vec(&reply).expect("serialize reply"));
    }

    /// Callback when a parked thought resolves — a reply arrived, or it timed out (200 blocks).
    #[private]
    pub fn on_thought(
        &mut self,
        mind_id: u64,
        request_id: u64,
        #[callback_result] reply: Result<String, PromiseError>,
    ) {
        let removed = self.pending.remove(&request_id);
        let cost = removed.map(|p| p.cost_paid).unwrap_or(self.thought_cost);
        let now = env::block_timestamp();
        self.finalize_thought(mind_id, reply.map_err(|_| ()), now, cost);
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

    /// Reap a Mind that has slept past `GHOST_AFTER_NS` into a ghost and credit its
    /// 0.25 NEAR hatch reserve back to the owner as a claimable rebate. Callable by
    /// anyone (a keeper action); on the testnet demo build the window is minutes.
    pub fn reap(&mut self, id: u64) {
        let now = env::block_timestamp();
        {
            let mind = self.minds.get(&id).expect("no such Mind");
            assert!(!mind.ghost, "already a ghost");
            assert!(
                crate::state::is_reapable(mind.asleep_since, now),
                "not ready to reap — still within the sleep window"
            );
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
        }
    }

    fn assert_admin(&self) {
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "only the contract account may change economy parameters"
        );
    }

    /// Re-peg the cost of one thought (flag #1). Bounded by `economy::MAX_THOUGHT_COST` so a
    /// mis-set or hostile admin key cannot make Minds bankrupt themselves in a single thought.
    pub fn set_thought_cost(&mut self, yocto: U128) {
        self.assert_admin();
        let c = yocto.0;
        assert!(c > 0, "thought cost must be positive");
        assert!(c <= economy::MAX_THOUGHT_COST, "thought cost above the safety ceiling");
        // Keep the guest-covers-a-thought invariant: the 70% a minimum guest actually leaves
        // the Mind must still exceed one thought. Re-pegging the cost up (flag #1) therefore
        // requires raising the guest minimum first, rather than silently inverting the economy.
        assert!(
            economy::guest_split(self.guest_min_price).to_mind > c,
            "thought cost too high for the guest minimum — raise the guest minimum first"
        );
        self.thought_cost = c;
        env::log_str(&format!("param_set thought_cost={c}"));
    }

    /// Set the minimum a guest must attach to `chat`. Kept at or above the thought cost so a
    /// guest always covers the thought they trigger (no free-rider drain).
    pub fn set_guest_min_price(&mut self, yocto: U128) {
        self.assert_admin();
        let p = yocto.0;
        // The Mind keeps only the 70% guest share, so compare THAT to the thought cost, not
        // the gross deposit — otherwise a "p >= cost" check still leaves the Mind net-draining.
        assert!(
            economy::guest_split(p).to_mind > self.thought_cost,
            "guest minimum must cover a thought after the 30% owner/treasury split"
        );
        self.guest_min_price = p;
        env::log_str(&format!("param_set guest_min_price={p}"));
    }

    /// Set the minimum paid-`revive` deposit. The free wake paths (feed / guest chat) are
    /// unaffected, so this never becomes the only way back.
    pub fn set_revive_price(&mut self, yocto: U128) {
        self.assert_admin();
        let p = yocto.0;
        // The minimum revive must actually wake a Mind: its 80% share has to reach one thought.
        assert!(
            economy::revive_split(p).to_mind >= self.thought_cost,
            "revive price must be enough to wake a Mind"
        );
        self.revive_price = p;
        env::log_str(&format!("param_set revive_price={p}"));
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
        let id: u64 = token_id.parse().expect("token_id must be a number");
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
        let id: u64 = token_id.parse().expect("token_id must be a number");
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
        assert!(
            env::attached_deposit() >= NearToken::from_yoctonear(1),
            "approving needs a deposit (>= 1 yoctoNEAR) to cover approval storage"
        );
        let id: u64 = token_id.parse().expect("token_id must be a number");
        let (owner, approval_id, is_new) = {
            let mind = self.minds.get_mut(&id).expect("no such Mind");
            assert_eq!(env::predecessor_account_id(), mind.owner, "only the owner can approve");
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
        let id: u64 = token_id.parse().expect("token_id must be a number");
        let removed = {
            let mind = self.minds.get_mut(&id).expect("no such Mind");
            assert_eq!(env::predecessor_account_id(), mind.owner, "only the owner can revoke");
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
        let id: u64 = token_id.parse().expect("token_id must be a number");
        let freed: u64 = {
            let mind = self.minds.get_mut(&id).expect("no such Mind");
            assert_eq!(env::predecessor_account_id(), mind.owner, "only the owner can revoke");
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
    assert!(attached >= cost, "attach enough deposit to cover approval storage");
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

    #[test]
    #[should_panic(expected = "name must be")]
    fn hatch_rejects_an_overlong_name() {
        testing_env!(ctx(NearToken::from_near(2), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind("x".repeat(33));
    }

    #[test]
    #[should_panic(expected = "name must be")]
    fn hatch_rejects_an_empty_name() {
        testing_env!(ctx(NearToken::from_near(2), seed_all(0)).build());
        let mut c = Contract::default();
        c.hatch_mind(String::new());
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
        let _ = c.chat(0, "hi".to_string());

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
        let _ = c.chat(0, "hi".to_string());
    }

    #[test]
    #[should_panic(expected = "below the guest minimum")]
    fn guest_chat_below_the_price_is_rejected() {
        // A free-rider attaching 0 must not be able to spend the Mind's food.
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(0)).build());
        let _ = c.chat(0, "hi".to_string());
    }

    // --- think (owner) ---
    #[test]
    fn owner_think_spends_a_thought_without_payment() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("alice.near", NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hey".to_string());

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
        let _ = c.think(0, "hi".to_string());
    }

    // --- the brain: yield/resume thinking ---
    #[test]
    fn think_parks_a_request_and_spends_a_thought() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
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
        // respond is permissionless, so a griefer could try to store a huge reply.
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
        testing_env!(admin_ctx(NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Echo".to_string()); // balance 1.0, cost default 0.002
        let new_cost = crate::state::ONE_NEAR / 250; // 0.004
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        c.set_thought_cost(U128(new_cost));
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string());
        assert_eq!(
            c.get_mind(0).unwrap().balance,
            NearToken::from_yoctonear(crate::state::ONE_NEAR - new_cost)
        );
        // the in-flight thought locked in the new cost
        assert_eq!(c.pending.get(&0).unwrap().cost_paid, new_cost);
    }

    #[test]
    fn a_refund_returns_the_cost_locked_at_spend_time_not_the_new_one() {
        testing_env!(admin_ctx(NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Echo".to_string()); // balance 1.0
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let _ = c.think(0, "hi".to_string()); // pays the default 0.002, locked in Pending
        let locked = c.pending.get(&0).unwrap().cost_paid;
        c.set_thought_cost(U128(crate::state::ONE_NEAR / 250)); // raise to 0.004 while in flight
        // a timeout refunds exactly the locked 0.002 -> balance back to 1.0, not 1.002
        c.finalize_thought(0, Err(()), 10, locked);
        assert_eq!(c.get_mind(0).unwrap().balance, NearToken::from_near(1));
    }

    #[test]
    fn revive_wakes_an_asleep_mind_with_an_80_20_split() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_yoctonear(0), false, 500)); // asleep, empty
        testing_env!(ctx_from("alice.near", NearToken::from_near(1)).build()); // pay the 1.0 revive price
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
        testing_env!(ctx_from("alice.near", NearToken::from_millinear(500)).build()); // 0.5 < 1.0
        c.revive(0);
    }

    // --- governance invariants (regressions from the adversarial review) ---

    #[test]
    #[should_panic(expected = "raise the guest minimum first")]
    fn raising_thought_cost_above_what_a_min_guest_covers_is_rejected() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default(); // guest_min 0.01 -> a guest leaves the Mind 0.007
        // 0.008 is under the 0.1 ceiling but above the 0.007 a minimum guest actually covers.
        c.set_thought_cost(U128(crate::state::ONE_NEAR * 8 / 1000));
    }

    #[test]
    #[should_panic(expected = "after the 30%")]
    fn a_guest_minimum_equal_to_the_thought_cost_is_rejected() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default(); // thought_cost 0.002
        // p == cost looks fine on the gross deposit, but the Mind keeps only 0.0014 of it.
        c.set_guest_min_price(U128(economy::THOUGHT_COMPUTE_COST));
    }

    #[test]
    fn raising_thought_cost_after_raising_the_guest_minimum_is_allowed() {
        testing_env!(admin_ctx(NearToken::from_yoctonear(0)).build());
        let mut c = Contract::default();
        // Lift the guest minimum first, then the thought cost may follow.
        c.set_guest_min_price(U128(crate::state::ONE_NEAR / 10)); // 0.1 -> guest leaves 0.07
        c.set_thought_cost(U128(crate::state::ONE_NEAR * 8 / 1000)); // 0.008 < 0.07, ok now
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

    // --- the no-withdraw invariant ---
    #[test]
    fn claiming_earnings_never_touches_the_mind_balance() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        // a guest chat accrues owner_unclaimed and raises the Mind's own balance
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
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

    #[test]
    fn svg_for_bare_is_transparent_current_state_art() {
        let mut c = Contract::default();
        c.minds.insert(0, make_mind(NearToken::from_near(1), false, 0)); // full
        let framed = c.svg_for(0).expect("some");
        let bare = c.svg_for_bare(0).expect("some");
        assert!(bare.trim_start().starts_with("<svg"));
        // The habitat floats the creature in its own light beam, so the bare
        // variant must not paint its own background window (art.rs render_bare).
        assert!(framed.contains("url(#bg"), "framed art paints a background");
        assert!(!bare.contains("url(#bg"), "bare art is transparent");
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
    }

    #[test]
    fn nft_token_carries_owner_title_and_live_media() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
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
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("A".to_string()); // 0 alice
        c.hatch_mind("B".to_string()); // 1 alice
        testing_env!(ctx_from("bob.near", NearToken::from_near(2)).build());
        c.hatch_mind("C".to_string()); // 2 bob

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
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string()); // alice owns token 0
        // a guest chat accrues alice's 20% cut and raises the Mind's own balance + memory
        testing_env!(ctx_from("bob.near", NearToken::from_millinear(10)).build());
        let _ = c.chat(0, "hi".to_string());
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
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
        testing_env!(ctx_from("bob.near", NearToken::from_yoctonear(1)).build());
        c.nft_transfer("carol.near".parse().unwrap(), "0".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "yocto")]
    fn transfer_requires_exactly_one_yocto() {
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
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
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
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
        testing_env!(ctx_from("alice.near", NearToken::from_near(2)).build());
        let mut c = Contract::default();
        c.hatch_mind("Rue".to_string());
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
