"use client";

// Wallet plumbing — NEAR Wallet Selector (MyNearWallet + Meteor) behind a tiny context.
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
  type WalletSelector,
  type AccountState,
} from "@near-wallet-selector/core";
import {
  setupModal,
  type WalletSelectorModal,
} from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { NETWORK, CONTRACT_ID, isLive, type Signer } from "@/lib/chain";

type Ctx = {
  /** True once the selector has initialised (live mode only). */
  ready: boolean;
  accountId: string | null;
  signIn: () => void;
  signOut: () => Promise<void>;
  /** A signer for lib/chain writes — null until a wallet is connected. */
  signer: Signer | null;
};

const WalletCtx = createContext<Ctx>({
  ready: false,
  accountId: null,
  signIn: () => {},
  signOut: async () => {},
  signer: null,
});

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
  const [accountId, setAccountId] = useState<string | null>(null);

  useEffect(() => {
    if (!isLive()) return; // preview mode — no contract, no wallet needed
    let sub: { unsubscribe: () => void } | undefined;
    let cancelled = false;
    (async () => {
      const sel = await setupWalletSelector({
        network: NETWORK === "mainnet" ? "mainnet" : "testnet",
        modules: [setupMyNearWallet(), setupMeteorWallet()],
      });
      if (cancelled) return;
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

  const signIn = useCallback(() => modal?.show(), [modal]);

  const signOut = useCallback(async () => {
    if (!selector) return;
    const w = await selector.wallet();
    await w.signOut();
    setAccountId(null);
  }, [selector]);

  const signer = useMemo<Signer | null>(() => {
    if (!selector || !accountId) return null;
    return {
      async signAndSendTransaction(params) {
        const w = await selector.wallet();
        return (w.signAndSendTransaction as unknown as SignFn)(params);
      },
    };
  }, [selector, accountId]);

  const value = useMemo<Ctx>(
    () => ({ ready: !!selector, accountId, signIn, signOut, signer }),
    [selector, accountId, signIn, signOut, signer]
  );

  return <WalletCtx.Provider value={value}>{children}</WalletCtx.Provider>;
}
