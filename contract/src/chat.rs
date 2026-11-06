//! Chat without a transaction per message.
//!
//! The player signs one message per session (NEP-413, checked off chain), then talks to a
//! Mind through the worker, which answers straight away and settles the usage here in
//! batches (`settle_chats`):
//!
//! - **Your own Mind** pays each reply from its food, exactly as `think` does.
//! - **Someone else's Mind**: the guest first buys chat credits (`buy_chat_credits`, one
//!   approval), and each message spends `guest_min_price` of them with the usual 90/10 (owner/protocol)
//!   split, exactly as `chat` does.
//!
//! A batch can only take what was prepaid: a Mind's food or a guest's credits, never more.
//! Each responder numbers its batches, so a batch sent twice (a retry after a lost reply)
//! settles once. Lives in its own file as a child module of `contract`, so it can use the
//! contract's private state and helpers.

use super::*;
use near_sdk::store::LookupMap;

/// Prepaid guest chat credits per account (yoctoNEAR). Own prefix: state layout unchanged.
fn chat_credits() -> LookupMap<AccountId, u128> {
    LookupMap::new(b"c".to_vec())
}

/// The last batch number each responder settled.
fn settle_nonces() -> LookupMap<AccountId, u64> {
    LookupMap::new(b"n".to_vec())
}

/// Bounds on one settlement transaction, so it always fits in its gas.
pub const MAX_SETTLE_ITEMS: usize = 40;
pub const MAX_SETTLE_COUNT: u32 = 200;
const MAX_DIGEST_LEN: usize = 128;

/// What one payer used with one Mind since the last batch.
#[near(serializers = [json])]
pub struct ChatUse {
    pub mind_id: u64,
    pub payer: AccountId,
    /// True when the payer kept the Mind when they talked (paid from her food), false for a
    /// guest (paid from their chat credits).
    pub own: bool,
    pub count: u32,
    /// The Mind's latest reply in this batch, shown on her card.
    pub last_reply: Option<String>,
}

/// What a batch actually charged (the worker logs it next to what it asked for).
#[near(serializers = [json])]
pub struct SettleReport {
    pub batch: u64,
    pub charged: u32,
    pub skipped: u32,
}

impl Contract {
    /// Charge one item; returns how many of its messages were paid for.
    fn settle_one(&mut self, u: &ChatUse, responder: &AccountId, now: u64) -> u32 {
        let cost = self.thought_cost;
        let price = self.guest_min_price;
        self.settle_metabolism(u.mind_id, now);
        let Some(mind) = self.minds.get(&u.mind_id) else { return 0 };
        if mind.ghost {
            return 0;
        }
        // `paid`: messages charged to the payer; `thoughts`: thoughts her food actually paid
        // for, which is all the responder may earn (it can never be paid from thin air).
        let (mut paid, mut thoughts) = (0u32, 0u32);
        if u.own {
            for _ in 0..u.count {
                if !self.minds.get_mut(&u.mind_id).unwrap().spend_one_thought(now, cost) {
                    break;
                }
                paid += 1;
            }
            thoughts = paid;
        } else {
            let mut credits = chat_credits();
            let mut left = credits.get(&u.payer).copied().unwrap_or(0);
            for _ in 0..u.count {
                if left < price {
                    break;
                }
                // She answers on her own food (her owner feeds her); a guest pays only for
                // replies she could afford: 90% to her owner, 10% to the protocol.
                if !self.minds.get_mut(&u.mind_id).unwrap().spend_one_thought(now, cost) {
                    break;
                }
                left -= price;
                self.credit_guest_payment(u.mind_id, price, now, None);
                thoughts += 1;
                paid += 1;
            }
            if left == 0 {
                credits.remove(&u.payer);
            } else {
                credits.insert(u.payer.clone(), left);
            }
        }
        if thoughts > 0 {
            self.pay_for_thought(u.mind_id, cost * thoughts as u128, Some(responder.clone()));
        }
        if paid > 0 {
            if let Some(reply) = &u.last_reply {
                let m = self.minds.get_mut(&u.mind_id).unwrap();
                m.last_reply = reply.chars().take(MAX_REPLY_LEN).collect();
                m.last_reply_ts = now;
            }
        }
        paid
    }
}

#[near]
impl Contract {
    /// Prepay chat credits for talking to other keepers' Minds (one approval for many
    /// messages). Credits are spent message by message as the worker settles them.
    #[payable]
    pub fn buy_chat_credits(&mut self) -> NearToken {
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= self.guest_min_price, "buy at least one message of chat credits");
        let caller = env::predecessor_account_id();
        let mut credits = chat_credits();
        let total = credits.get(&caller).copied().unwrap_or(0).saturating_add(deposit);
        credits.insert(caller.clone(), total);
        env::log_str(&format!("chat_credits_bought account={caller} amount={deposit}"));
        NearToken::from_yoctonear(total)
    }

    pub fn chat_credits_of(&self, account_id: AccountId) -> NearToken {
        NearToken::from_yoctonear(chat_credits().get(&account_id).copied().unwrap_or(0))
    }

    /// The last batch `account_id` settled (0 = none yet); the next one must be this + 1.
    pub fn settle_nonce_of(&self, account_id: AccountId) -> u64 {
        settle_nonces().get(&account_id).copied().unwrap_or(0)
    }

    /// An approved responder settles the chats it answered off chain. `digest` is a hash of
    /// the batch's transcript, logged so the conversation can be checked later.
    pub fn settle_chats(&mut self, batch: u64, items: Vec<ChatUse>, digest: Option<String>) -> SettleReport {
        let caller = env::predecessor_account_id();
        require!(responders().contains(&caller), "only an approved responder may settle chats");
        require!(items.len() <= MAX_SETTLE_ITEMS, "too many items in one batch");
        let mut nonces = settle_nonces();
        let last = nonces.get(&caller).copied().unwrap_or(0);
        if batch <= last {
            env::log_str(&format!("chats_already_settled batch={batch}"));
            return SettleReport { batch, charged: 0, skipped: 0 };
        }
        require!(batch == last + 1, "batch out of order");
        nonces.insert(caller.clone(), batch);
        let now = env::block_timestamp();
        let (mut charged, mut skipped) = (0u32, 0u32);
        for u in &items {
            require!(u.count <= MAX_SETTLE_COUNT, "too many messages in one item");
            let paid = self.settle_one(u, &caller, now);
            charged += paid;
            skipped += u.count - paid;
        }
        let digest: String = digest.unwrap_or_default().chars().take(MAX_DIGEST_LEN).collect();
        env::log_str(&format!("chats_settled batch={batch} charged={charged} skipped={skipped} digest={digest}"));
        SettleReport { batch, charged, skipped }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const MILLI: u128 = crate::state::ONE_NEAR / 1000;

    fn as_who(who: &str, deposit: u128) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(who.parse().unwrap())
            .current_account_id("hm.near".parse().unwrap())
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .random_seed([7; 32])
            .block_timestamp(1_000) // non-zero: asleep_since == 0 means awake
            .build());
    }

    /// Alice hatches Mind 0 (food 0.1, treasury 0.65); worker.near may settle.
    fn colony() -> Contract {
        as_who("alice.near", 1000 * MILLI);
        let mut c = Contract::default();
        c.hatch_mind("Rue".into(), None);
        as_who("hm.near", 0);
        c.add_responder("worker.near".parse().unwrap());
        c
    }

    fn item(payer: &str, own: bool, count: u32) -> ChatUse {
        ChatUse { mind_id: 0, payer: payer.parse().unwrap(), own, count, last_reply: Some("hi!".into()) }
    }

    fn earned(c: &Contract) -> u128 {
        c.responder_earnings_of("worker.near".parse().unwrap()).as_yoctonear()
    }

    #[test]
    fn own_chats_are_paid_from_her_food_and_earn_the_worker() {
        let mut c = colony();
        as_who("worker.near", 0);
        let r = c.settle_chats(1, vec![item("alice.near", true, 5)], Some("abc".into()));
        assert_eq!((r.charged, r.skipped), (5, 0));
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance.as_yoctonear(), 90 * MILLI); // 0.1 - 5 × 0.002
        assert_eq!(m.thought_count, 5);
        assert_eq!(m.last_reply, "hi!");
        assert_eq!(earned(&c), 10 * MILLI);
        assert_eq!(c.treasury_balance().as_yoctonear(), 650 * MILLI);
    }

    #[test]
    fn own_chats_stop_when_her_food_runs_out() {
        let mut c = colony();
        as_who("worker.near", 0);
        let r = c.settle_chats(1, vec![item("alice.near", true, 60)], None);
        assert_eq!((r.charged, r.skipped), (50, 10)); // 0.1 buys 50 thoughts at 0.002
        let m = c.get_mind(0).unwrap();
        assert_eq!(m.balance.as_yoctonear(), 0);
        assert_ne!(m.asleep_since, 0);
        assert_eq!(earned(&c), 100 * MILLI);
    }

    #[test]
    fn guest_chats_pay_90_to_the_owner_10_to_the_protocol() {
        let mut c = colony();
        as_who("bob.near", 30 * MILLI);
        assert_eq!(c.buy_chat_credits().as_yoctonear(), 30 * MILLI);
        as_who("worker.near", 0);
        let r = c.settle_chats(1, vec![item("bob.near", false, 2)], None);
        assert_eq!((r.charged, r.skipped), (2, 0));
        assert_eq!(c.chat_credits_of("bob.near".parse().unwrap()).as_yoctonear(), 10 * MILLI);
        let m = c.get_mind(0).unwrap();
        // her food only pays the 2 thoughts: 0.1 - 0.004; her owner gets 2 × 0.009
        assert_eq!(m.balance.as_yoctonear(), 96 * MILLI);
        assert_eq!(m.owner_unclaimed.as_yoctonear(), 18 * MILLI);
        assert_eq!(c.treasury_balance().as_yoctonear(), 652 * MILLI);
        assert_eq!(earned(&c), 4 * MILLI);
    }

    #[test]
    fn guest_chats_never_take_more_than_was_prepaid() {
        let mut c = colony();
        as_who("bob.near", 10 * MILLI);
        c.buy_chat_credits();
        as_who("worker.near", 0);
        let r = c.settle_chats(1, vec![item("bob.near", false, 3), item("carol.near", false, 4)], None);
        assert_eq!((r.charged, r.skipped), (1, 6));
        assert_eq!(c.chat_credits_of("bob.near".parse().unwrap()).as_yoctonear(), 0);
    }

    #[test]
    fn a_batch_sent_twice_settles_once() {
        let mut c = colony();
        as_who("worker.near", 0);
        c.settle_chats(1, vec![item("alice.near", true, 5)], None);
        let again = c.settle_chats(1, vec![item("alice.near", true, 5)], None);
        assert_eq!(again.charged, 0);
        assert_eq!(c.get_mind(0).unwrap().thought_count, 5);
        assert_eq!(c.settle_nonce_of("worker.near".parse().unwrap()), 1);
    }

    #[test]
    #[should_panic(expected = "batch out of order")]
    fn a_skipped_batch_number_is_refused() {
        let mut c = colony();
        as_who("worker.near", 0);
        c.settle_chats(2, vec![item("alice.near", true, 1)], None);
    }

    #[test]
    #[should_panic(expected = "only an approved responder may settle chats")]
    fn a_stranger_cannot_settle() {
        let mut c = colony();
        as_who("mallory.near", 0);
        c.settle_chats(1, vec![item("alice.near", true, 50)], None);
    }

    #[test]
    #[should_panic(expected = "buy at least one message")]
    fn credits_below_one_message_are_refused() {
        let mut c = colony();
        as_who("bob.near", 9 * MILLI);
        c.buy_chat_credits();
    }

    #[test]
    fn a_ghost_is_never_charged() {
        let mut c = colony();
        c.minds.get_mut(&0).unwrap().ghost = true;
        as_who("bob.near", 10 * MILLI);
        c.buy_chat_credits();
        as_who("worker.near", 0);
        let r = c.settle_chats(1, vec![item("bob.near", false, 1)], None);
        assert_eq!(r.charged, 0);
        assert_eq!(c.chat_credits_of("bob.near".parse().unwrap()).as_yoctonear(), 10 * MILLI);
    }
}
