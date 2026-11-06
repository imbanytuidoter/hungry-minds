"use client";

// Connect / account chip for the nav. Renders nothing in preview mode (no contract to
// connect to), so preview pages look exactly as before. Uses the existing .btn classes;
// the designer can restyle freely.

import { isLive } from "@/lib/chain";
import { useWallet } from "./WalletProvider";

function shorten(id: string): string {
  return id.length > 18 ? `${id.slice(0, 6)}…${id.slice(-7)}` : id;
}

export default function ConnectButton() {
  const { ready, accountId, signIn, signOut } = useWallet();

  if (!isLive() || !ready) return null;

  if (accountId) {
    return (
      <button
        className="btn btn-ghost"
        style={{ padding: "9px 14px" }}
        onClick={() => signOut()}
        title="Disconnect wallet"
      >
        {shorten(accountId)}
      </button>
    );
  }

  return (
    <button
      className="btn btn-ghost"
      style={{ padding: "9px 14px" }}
      onClick={() => void signIn().catch(() => {})}
    >
      Connect wallet
    </button>
  );
}
