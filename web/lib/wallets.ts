// Every NEAR wallet Wallet Selector supports, loaded on demand when the wallet layer starts,
// so the wallets' code stays out of the first page load. A wallet whose module fails to
// load is skipped instead of breaking the picker for all the others.
//
// WalletConnect (and Unity Wallet, which connects through it) needs a free project id from
// https://cloud.reown.com — set NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID to turn them on.

import type { WalletModuleFactory } from "@near-wallet-selector/core";
import { CONTRACT_ID, NETWORK, WALLET_RPC_URLS } from "@/lib/chain";

// Each module is typed for its own wallet kind (injected, browser, hardware…); the selector takes them all.
type Loader = () => Promise<unknown>;

const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || "";

const META = {
  name: "Hungry Minds",
  description: "Hatch, feed and talk to AI Minds that live on NEAR.",
  url: typeof window !== "undefined" ? window.location.origin : "https://hungryminds.app",
  icons: [typeof window !== "undefined" ? `${window.location.origin}/favicon.ico` : ""],
};

// EVM wallets (MetaMask, Rabby, OKX/Coinbase extensions…) through NEAR's own EVM RPC
// (NEP-518). The wallet's 0x address is the NEAR account; no WalletConnect key needed,
// it connects to whatever EVM extension the browser has.
async function evmWallets() {
  const [{ createConfig, http, injected }, { defineChain }, { setupEthereumWallets }] = await Promise.all([
    import("@wagmi/core"),
    import("viem"),
    import("@near-wallet-selector/ethereum-wallets"),
  ]);
  const main = NETWORK === "mainnet";
  const rpc = main ? "https://eth-rpc.mainnet.near.org" : "https://eth-rpc.testnet.near.org";
  const near = defineChain({
    id: (main ? 397 : 398) as number,
    name: main ? "NEAR Protocol" : "NEAR Protocol Testnet",
    nativeCurrency: { decimals: 18, name: "NEAR", symbol: "NEAR" },
    rpcUrls: { default: { http: [rpc] } },
    blockExplorers: { default: { name: "NEAR Explorer", url: main ? "https://eth-explorer.near.org" : "https://eth-explorer-testnet.near.org" } },
    testnet: !main,
  });
  const wagmiConfig = createConfig({ chains: [near], transports: { [near.id]: http() }, connectors: [injected()] });
  // The module hands `nearNodeUrl` straight to `new JsonRpcProvider(...)`, which in
  // @near-js/providers 2.x takes a ConnectionInfo ({ url }), not a bare string: a string
  // fetches `undefined` and every sign-in fails with "Failed to view the relayer public key".
  const nearNodeUrl = { url: WALLET_RPC_URLS[0] } as unknown as string;
  return setupEthereumWallets({ wagmiConfig, nearNodeUrl, alwaysOnboardDuringSignIn: true });
}

// Not offered, checked 2026-11-04: MyNearWallet is being retired and its login page refuses
// new app connections; Bitte's testnet wallet domain no longer resolves (mainnet answers 402).
const LOADERS: Loader[] = [
  async () => (await import("@near-wallet-selector/meteor-wallet")).setupMeteorWallet(),
  async () => (await import("@near-wallet-selector/meteor-wallet-app")).setupMeteorWalletApp({ contractId: CONTRACT_ID }),
  async () => (await import("@near-wallet-selector/intear-wallet")).setupIntearWallet(),
  async () => (await import("@near-wallet-selector/hot-wallet")).setupHotWallet(),
  async () => (await import("@near-wallet-selector/here-wallet")).setupHereWallet(),
  async () => (await import("@near-wallet-selector/sender")).setupSender(),
  async () => (await import("@near-wallet-selector/nightly")).setupNightly(),
  // OKX's module never tells the extension which network to use, so OKX always signs for
  // mainnet; on testnet every transaction fails with a bare "sign Error". Mainnet only.
  ...(NETWORK === "mainnet" ? [async () => (await import("@near-wallet-selector/okx-wallet")).setupOKXWallet()] : []),
  async () => (await import("@near-wallet-selector/bitget-wallet")).setupBitgetWallet(),
  async () => (await import("@near-wallet-selector/near-mobile-wallet")).setupNearMobileWallet(),
  async () => (await import("@near-wallet-selector/math-wallet")).setupMathWallet(),
  async () => (await import("@near-wallet-selector/welldone-wallet")).setupWelldoneWallet(),
  async () => (await import("@near-wallet-selector/coin98-wallet")).setupCoin98Wallet(),
  async () => (await import("@near-wallet-selector/narwallets")).setupNarwallets(),
  async () => (await import("@near-wallet-selector/xdefi")).setupXDEFI(),
  async () => (await import("@near-wallet-selector/ramper-wallet")).setupRamperWallet(),
  async () => (await import("@near-wallet-selector/near-snap")).setupNearSnap(),
  async () => (await import("@near-wallet-selector/ledger")).setupLedger(),
  // NEAR's testnet EVM relayer (eth-rpc.testnet.near.org) refuses the sponsored onboarding
  // tx ("account is not onboarded or key was revoked", checked 2026-11-04), so a new EVM
  // wallet can never finish signing in on testnet. Mainnet only.
  ...(NETWORK === "mainnet" ? [evmWallets] : []),
  ...(WC_PROJECT_ID
    ? [
        async () => (await import("@near-wallet-selector/wallet-connect")).setupWalletConnect({ projectId: WC_PROJECT_ID, metadata: META }),
        async () => (await import("@near-wallet-selector/unity-wallet")).setupUnityWallet({ projectId: WC_PROJECT_ID, metadata: META }),
      ]
    : []),
];

export async function walletModules(): Promise<WalletModuleFactory[]> {
  const loaded = await Promise.allSettled(LOADERS.map((load) => load()));
  return loaded.flatMap((r) => {
    if (r.status === "fulfilled") return [r.value as WalletModuleFactory];
    console.warn("wallet module skipped:", r.reason);
    return [];
  });
}
