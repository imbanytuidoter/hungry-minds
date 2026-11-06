"use client";

// Wallet plumbing — NEAR Wallet Selector (every NEAR wallet, see lib/wallets.ts) behind a tiny context.
// It only initialises when a contract is configured (isLive); in preview mode it renders
// as a no-op provider so the site needs no wallet. The exposed `signer` is exactly what
// lib/chain's write helpers expect, so UI code calls chain.feed(signer, …) without caring
// which wallet is behind it. This is functional plumbing — the picker is Wallet Selector's
// own modal; styling is the designer's to theme.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  setupWalletSelector,
  internalActionToNaj,
  type WalletSelector,
  type AccountState,
} from "@near-wallet-selector/core";
import {
  setupModal,
  type WalletSelectorModal,
} from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { walletModules } from "@/lib/wallets";
import { chatSession } from "@/lib/chatClient";
import { Account, KeyPairSigner, providers } from "near-api-js";
import { Buffer } from "buffer";
import { NETWORK, CONTRACT_ID, RPC_URLS, WALLET_RPC_URLS, isLive, type Signer } from "@/lib/chain";

type Ctx = {
  /** True once the selector has initialised (live mode only). */
  ready: boolean;
  accountId: string | null;
  signIn: () => Promise<void>;
  /** True when the connected account signs with a key kept in this browser (QA builds). */
  burner: boolean;
  signOut: () => Promise<void>;
  /** A signer for lib/chain writes — null until a wallet is connected. */
  signer: Signer | null;
  /** NEP-413: sign a text with the account's own key (no transaction) — null until connected. */
  signMessage: SignText | null;
};

/** What a NEP-413 signature comes back as (signature base64). */
export type SignedText = { accountId: string; publicKey: string; signature: string };
export type SignText = (message: string, nonce: Uint8Array, recipient: string) => Promise<SignedText>;

const WalletCtx = createContext<Ctx>({
  ready: false,
  accountId: null,
  signIn: async () => {},
  burner: false,
  signOut: async () => {},
  signer: null,
  signMessage: null,
});

// ── Key kept in this browser (QA builds only) ────────────────────────────────
// A QA build (NEXT_PUBLIC_QA_SIGNIN=1, never set for the real site) signs with a testnet key
// from localStorage, so a headless browser can drive every action through the real UI.

const BURNER_KEY = "hm-burner";
type Burner = { accountId: string; key: string };

function loadBurner(): Burner | null {
  try {
    return JSON.parse(localStorage.getItem(BURNER_KEY) || "null");
  } catch {
    return null;
  }
}

const rpcProvider = () => new providers.FailoverRpcProvider(RPC_URLS.map((url) => new providers.JsonRpcProvider({ url })));

type Call = { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } };

function burnerSigner(b: Burner): Signer {
  const account = new Account(b.accountId, rpcProvider(), KeyPairSigner.fromSecretKey(b.key as `ed25519:${string}`));
  return {
    async signAndSendTransaction(params) {
      let out: unknown;
      for (const a of params.actions as Call[]) {
        out = await account.callFunction({
          contractId: params.receiverId ?? CONTRACT_ID,
          methodName: a.params.methodName,
          args: a.params.args as Record<string, unknown>,
          deposit: a.params.deposit,
          gas: a.params.gas,
        });
      }
      return out;
    },
  };
}

export const useWallet = () => useContext(WalletCtx);

// A wallet's signAndSendTransaction accepts a superset of our params; narrow it here so
// we can forward lib/chain's shape without pulling the whole union into our types.
type SignFn = (p: {
  receiverId?: string;
  signerId?: string;
  actions: unknown[];
}) => Promise<unknown>;

const pickAccount = (accts: AccountState[]): string | null =>
  accts.find((a) => a.active)?.accountId ?? accts[0]?.accountId ?? null;

export default function WalletProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [walletAccount, setAccountId] = useState<string | null>(null);
  // Every page load starts signed out, even when the wallet kept its session: the player
  // signs in again with "Connect wallet", which then reuses that session (no new access key).
  const [unlocked, setUnlocked] = useState(false);
  const [burnerAcc, setBurner] = useState<Burner | null>(null);
  const accountId = burnerAcc?.accountId ?? (unlocked ? walletAccount : null);

  useEffect(() => {
    if (!isLive()) return;
    if (process.env.NEXT_PUBLIC_QA_SIGNIN === "1") setBurner(loadBurner());
  }, []);

  useEffect(() => {
    if (!isLive()) return; // preview mode — no contract, no wallet needed
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;
    (async () => {
      const sel = await setupWalletSelector({
        network: NETWORK === "mainnet" ? "mainnet" : "testnet",
        // the wallets' own RPC calls skip FastNEAR's rate-limited free tier
        fallbackRpcUrls: WALLET_RPC_URLS,
        modules: await walletModules(),
      });
      if (cancelled) return;
      // The page is a wallet's redirect back from a sign-in or a signed transaction: the
      // player just signed in there, so stay signed in.
      const q = new URLSearchParams(window.location.search);
      if (["account_id", "public_key", "all_keys", "transactionHashes", "errorCode"].some((k) => q.has(k))) setUnlocked(true);
      const m = setupModal(sel, { contractId: CONTRACT_ID });
      setAccountId(pickAccount(sel.store.getState().accounts));
      sub = sel.store.observable.subscribe((s) =>
        setAccountId(pickAccount(s.accounts))
      );
      setSelector(sel);
      setModal(m);
    })().catch((e) => console.error("wallet-selector init failed:", e));
    return () => {
      cancelled = true;
      sub?.unsubscribe();
    };
  }, []);

  // Signing in always asks the wallet. With no session: pick a wallet and approve there. With a
  // session the wallet kept (after a reload or a browser restart): the wallet is asked to sign
  // a sign-in text (NEP-413: an approval, no transaction, no gas), and that one signature also
  // opens the chat session, so the first chat message needs no popup. A wallet that can't sign
  // a text is signed out and connected again through its own approval. Refusing keeps you out.
  const signIn = useCallback(async () => {
    if (!walletAccount || !selector) {
      setUnlocked(true);
      modal?.show();
      return;
    }
    const w = await selector.wallet();
    if (!("signMessage" in w) || !w.signMessage) {
      await w.signOut().catch(() => {});
      setAccountId(null);
      setUnlocked(true);
      modal?.show();
      return;
    }
    let signed = false;
    const sign: SignText = async (message, nonce, recipient) => {
      const s = await w.signMessage!({ message, nonce: Buffer.from(nonce), recipient });
      if (!s) throw new Error("The wallet didn't approve the sign-in.");
      signed = true;
      return { accountId: s.accountId, publicKey: s.publicKey, signature: s.signature };
    };
    try {
      await chatSession(walletAccount, sign, true);
    } catch (e) {
      // the wallet said no (or signed as someone else): stay signed out
      if (!signed || /signed as/.test(String((e as Error)?.message))) throw e;
      // signed, but the chat server is down: you're in; chat will ask again when it's back
    }
    setUnlocked(true);
  }, [modal, walletAccount, selector]);

  const signOut = useCallback(async () => {
    setUnlocked(false);
    if (burnerAcc) {
      setBurner(null);
      return;
    }
    if (!selector) return;
    const w = await selector.wallet();
    await w.signOut();
    setAccountId(null);
  }, [selector, burnerAcc]);

  const signer = useMemo<Signer | null>(() => {
    if (burnerAcc) return burnerSigner(burnerAcc);
    if (!selector || !accountId) return null;
    return {
      async signAndSendTransaction(params) {
        const w = await selector.wallet();
        // Wallet Selector 10 takes near-api-js Action objects; every wallet module converts
        // them back itself, and a plain { type, params } action fails with "Unsupported NAJ action".
        const actions = (params.actions as Call[]).map((a) => internalActionToNaj(a));
        return (w.signAndSendTransaction as unknown as SignFn)({ ...params, actions });
      },
    };
  }, [selector, accountId, burnerAcc]);

  const signMessage = useMemo<SignText | null>(() => {
    if (burnerAcc) {
      const key = KeyPairSigner.fromSecretKey(burnerAcc.key as `ed25519:${string}`);
      return async (message, nonce, recipient) => {
        const s = await key.signNep413Message(message, burnerAcc.accountId, recipient, nonce);
        return { accountId: burnerAcc.accountId, publicKey: s.publicKey.toString(), signature: Buffer.from(s.signature).toString("base64") };
      };
    }
    if (!selector || !accountId) return null;
    return async (message, nonce, recipient) => {
      const w = await selector.wallet();
      if (!("signMessage" in w) || !w.signMessage) throw new Error("This wallet can't sign a message. Try Meteor, Intear or HOT.");
      const s = await w.signMessage({ message, nonce: Buffer.from(nonce), recipient });
      if (!s) throw new Error("The wallet didn't return a signature.");
      return { accountId: s.accountId, publicKey: s.publicKey, signature: s.signature };
    };
  }, [selector, accountId, burnerAcc]);

  const value = useMemo<Ctx>(
    () => ({ ready: !!selector, accountId, signIn, burner: !!burnerAcc, signOut, signer, signMessage }),
    [selector, accountId, signIn, burnerAcc, signOut, signer, signMessage]
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
