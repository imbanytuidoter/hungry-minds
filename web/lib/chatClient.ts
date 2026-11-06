// Chat without a transaction per message: the wallet signs one text (NEP-413) per day, the
// worker answers each message straight away, and settles the usage on chain in batches from
// what was prepaid (her food for her keeper, chat credits for a guest). See worker/chat-server.js.

import { CONTRACT_ID } from "@/lib/chain";
import type { SignText } from "@/components/WalletProvider";

const SESSION_KEY = (account: string) => `hm-chat-session:${CONTRACT_ID}:${account}`;

type Session = { token: string; expires: number };

function savedSession(account: string): Session | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY(account)) || "null") as Session | null;
    return s && s.expires > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

async function post<T>(action: string, body: unknown): Promise<{ status: number; data: T & { error?: string } }> {
  const res = await fetch(`/api/chat/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => ({ error: "bad reply from the chat server" })) };
}

/** A session token for `account`, asking the wallet to sign once if there is none yet. */
export async function chatSession(account: string, sign: SignText, fresh = false): Promise<string> {
  const saved = fresh ? null : savedSession(account);
  if (saved) return saved.token;
  const message = `Sign in to Hungry Minds chat as ${account}\n${Date.now()}`;
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const s = await sign(message, nonce, CONTRACT_ID);
  if (s.accountId !== account) throw new Error(`The wallet signed as ${s.accountId}, not ${account}.`);
  const { status, data } = await post<Session>("session", { ...s, message, nonce: btoa(String.fromCharCode(...nonce)) });
  if (status !== 200) throw new Error(data.error || "Chat sign-in failed.");
  try {
    localStorage.setItem(SESSION_KEY(account), JSON.stringify({ token: data.token, expires: data.expires }));
  } catch {
    /* private window: sign again next time */
  }
  return data.token;
}

/** True if a chat session is already open, so the next message needs no signature. */
export const hasChatSession = (account: string) => !!savedSession(account);

export type ChatReply = { reply: string; own: boolean; left: number; proof?: import("@/lib/game/engine").ReplyProof | null; via?: string | null };

/** Send one message; signs in first if needed. Throws with a readable message on refusal. */
export async function sendChat(account: string, sign: SignText, mindId: number, prompt: string): Promise<ChatReply> {
  let token = await chatSession(account, sign);
  let r = await post<ChatReply>("chat", { token, mindId, prompt });
  if (r.status === 401) {
    token = await chatSession(account, sign, true);
    r = await post<ChatReply>("chat", { token, mindId, prompt });
  }
  if (r.status !== 200) {
    const e = new Error(r.data.error || "The message didn't go through.") as Error & { left?: number; needsCredits?: boolean };
    e.needsCredits = r.status === 402 && /credits/i.test(r.data.error || "");
    throw e;
  }
  return r.data;
}

/** Messages `account` can still send this Mind before paying more (null if the server is offline). */
export async function chatAllowance(account: string, mindId: number): Promise<{ left: number; own: boolean } | null> {
  try {
    const res = await fetch(`/api/chat/allowance?account=${encodeURIComponent(account)}&mind=${mindId}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
