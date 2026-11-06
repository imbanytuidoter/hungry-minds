// Official agents: real data agents that run inside the gateway, so a Mind owner can connect
// one with a click (kind "official", url "official:<id>"), without hosting anything. They
// read public sources only, with no keys:
//   NEAR mainnet RPC (FastNEAR, dRPC), FastNEAR's account and holders API, Rhea (Ref)
//   prices and pools, Burrow's own views, NEAR Intents 1Click quotes, Polymarket's public
//   Gamma and Data APIs.
// Every result says where its numbers come from. Each skill has a JSON Schema for its input,
// which becomes the order form on the site, and a category for the shop.

const RPCS = (process.env.OFFICIAL_NEAR_RPC || "https://free.rpc.fastnear.com,https://near.drpc.org").split(",");
const TIMEOUT = 25_000;

async function getJson(url, init = {}, attempt = 0) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), headers: { accept: "application/json", "user-agent": "hungry-minds-agent/1.0", ...(init.headers || {}) } });
  // Public APIs rate-limit in bursts: wait a little and try again before calling it a failure.
  if (res.status === 429 && attempt < 2) {
    await new Promise((ok) => setTimeout(ok, 2500 * (attempt + 1)));
    return getJson(url, init, attempt + 1);
  }
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

async function view(contract, method, args = {}) {
  let last;
  for (const rpc of RPCS) {
    try {
      const j = await getJson(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") } }),
      });
      if (j.error || j.result?.error) throw new Error(String(j.error?.cause?.name || j.result?.error || j.error?.message).slice(0, 160));
      return JSON.parse(Buffer.from(j.result.result).toString());
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

async function rpcQuery(params) {
  let last;
  for (const rpc of RPCS) {
    try {
      const j = await getJson(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { finality: "final", ...params } }) });
      if (j.error) throw new Error(String(j.error.cause?.name || j.error.message));
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ── small caches for slow-changing lists ──
const cache = new Map();
async function cached(key, ms, fn) {
  const c = cache.get(key);
  if (c && Date.now() - c.t < ms) return c.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}
const refPrices = () => cached("ref-prices", 60_000, () => getJson("https://indexer.ref.finance/list-token-price"));
const intentTokens = () => cached("1click-tokens", 60_000, () => getJson("https://1click.chaindefuser.com/v0/tokens"));
const metaOf = (token) => cached(`meta:${token}`, 3_600_000, () => view(token, "ft_metadata"));

// ── formatting ──
const units = (raw, decimals) => {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  return Number(`${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals, s.length - decimals + 8)}`);
};
const num = (n, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? "—" : Math.abs(n) >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : Math.abs(n) >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : n.toFixed(d));
const usd = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const a = Math.abs(n);
  return sign + "$" + (a !== 0 && a < 1 ? a.toPrecision(3) : num(a));
};
const pct = (n) => (n === null || n === undefined || Number.isNaN(n) ? "—" : `${(n * 100).toFixed(2)}%`);
const NEAR_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
function needAccount(v, what = "account") {
  const id = String(v || "").trim().toLowerCase();
  if (!(NEAR_ID.test(id) && id.length >= 2 && id.length <= 64)) throw new Error(`give a NEAR ${what} id, like alice.near`);
  return id;
}

/** A token by contract id or symbol: { id, symbol, decimals, price }. */
async function resolveToken(q) {
  const s = String(q || "").trim();
  if (!s) throw new Error("which token?");
  const prices = await refPrices().catch(() => ({}));
  const lower = s.toLowerCase();
  if (s.includes(".") || /^[0-9a-f]{64}$/.test(lower)) {
    const p = prices[lower];
    const meta = p ? { symbol: p.symbol, decimals: p.decimal } : await metaOf(lower);
    return { id: lower, symbol: meta.symbol, decimals: meta.decimals, price: p ? Number(p.price) : null };
  }
  const sym = lower === "near" ? "wnear" : lower;
  const hits = Object.entries(prices).filter(([, v]) => v.symbol?.toLowerCase() === sym || (sym === "wnear" && v.symbol?.toLowerCase() === "wnear"));
  if (!hits.length) {
    const t = (await intentTokens()).find((x) => x.blockchain === "near" && x.symbol.toLowerCase() === sym);
    if (t) return { id: t.contractAddress, symbol: t.symbol, decimals: t.decimals, price: t.price };
    throw new Error(`no NEAR token called ${s}; give its contract id`);
  }
  // several tokens can share a symbol: take the one Rhea prices highest in liquidity order (first listed)
  const [id, v] = hits.find(([k]) => k === "wrap.near") || hits[0];
  return { id, symbol: v.symbol, decimals: v.decimal, price: Number(v.price) };
}

// ── the agents ──

const pmGamma = "https://gamma-api.polymarket.com";
const pmData = "https://data-api.polymarket.com/v2";

const AGENTS = [
  {
    id: "polymarket-pulse",
    name: "Polymarket Pulse",
    description: "Prediction-market intelligence from Polymarket's public data: the hottest markets, the most profitable wallets, and any wallet's positions and PnL.",
    skills: [
      {
        id: "hot-markets",
        name: "Hot prediction markets",
        category: "predict",
        description: "The most traded open Polymarket markets right now, with odds, 24 h volume and liquidity. Optionally about one topic.",
        examples: ["bitcoin", "election"],
        inputSchema: { type: "object", properties: { topic: { type: "string", description: "Only markets about this (optional)" }, limit: { type: "integer", description: "How many (1-15)", default: 8 } } },
        async run({ topic, limit = 8 }) {
          const n = Math.min(15, Math.max(1, Number(limit) || 8));
          // A topic goes through Polymarket's own search; otherwise the most traded markets.
          const list = topic
            ? (await getJson(`${pmGamma}/public-search?q=${encodeURIComponent(topic)}&limit_per_type=10&events_status=active`)).events.flatMap((e) => (e.markets || []).map((m) => ({ ...m, events: [{ slug: e.slug }] }))).filter((m) => m.active && !m.closed)
            : await getJson(`${pmGamma}/markets?limit=${n}&active=true&closed=false&order=volume24hr&ascending=false`);
          const pick = list.sort((a, b) => Number(b.volume24hr || 0) - Number(a.volume24hr || 0)).slice(0, n);
          if (!pick.length) return { text: `No open Polymarket market about “${topic}”.`, data: [] };
          const rows = pick.map((m) => {
            const outcomes = JSON.parse(m.outcomes || "[]");
            const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
            return { question: m.question, odds: outcomes.map((o, i) => `${o} ${pct(prices[i])}`).join(" / "), volume_24h: Number(m.volume24hr || 0), liquidity: Number(m.liquidity || 0), ends: m.endDate, url: `https://polymarket.com/event/${m.events?.[0]?.slug || m.slug}` };
          });
          return {
            text: `Most traded open Polymarket markets${topic ? ` about “${topic}”` : ""}:\n\n` + rows.map((r, i) => `${i + 1}. ${r.question}\n   ${r.odds} · 24 h volume ${usd(r.volume_24h)} · liquidity ${usd(r.liquidity)}${r.ends ? ` · ends ${r.ends.slice(0, 10)}` : ""}`).join("\n") + "\n\nSource: Polymarket Gamma API.",
            data: rows,
          };
        },
      },
      {
        id: "smart-wallets",
        name: "Smart money on Polymarket",
        category: "predict",
        description: "The most profitable Polymarket wallets over a period, with PnL and volume: who to watch.",
        examples: ["week", "month"],
        inputSchema: { type: "object", properties: { period: { type: "string", enum: ["DAY", "WEEK", "MONTH", "ALL"], default: "WEEK", description: "Period" }, limit: { type: "integer", default: 10, description: "How many (1-25)" } } },
        async run({ period = "WEEK", limit = 10 }) {
          const p = ["DAY", "WEEK", "MONTH", "ALL"].includes(String(period).toUpperCase()) ? String(period).toUpperCase() : "WEEK";
          const n = Math.min(25, Math.max(1, Number(limit) || 10));
          const j = await getJson(`${pmData}/leaderboard?timePeriod=${p}&orderBy=PNL&limit=${n}`);
          const rows = (j.data || []).map((x) => ({ rank: x.rank, wallet: x.user_id, name: x.user_name || "", pnl: x.pnl, volume: x.volume }));
          return {
            text: `Top Polymarket wallets by PnL (${p.toLowerCase()}):\n\n` + rows.map((r) => `${r.rank}. ${r.name || r.wallet.slice(0, 10) + "…"} (${r.wallet}) · PnL ${usd(r.pnl)} · volume ${usd(r.volume)}`).join("\n") + "\n\nOrder “Polymarket wallet report” with a wallet to see its positions. Source: Polymarket Data API.",
            data: rows,
          };
        },
      },
      {
        id: "wallet-report",
        name: "Polymarket wallet report",
        category: "predict",
        description: "A wallet's open and redeemable Polymarket positions: size, entry, current value and PnL.",
        examples: ["0xe9b710551dd82a44e79203c2394a2b10163ace7b"],
        inputSchema: { type: "object", required: ["wallet"], properties: { wallet: { type: "string", format: "address", description: "Polymarket wallet (0x…)" } } },
        async run({ wallet }) {
          const w = String(wallet || "").trim().toLowerCase();
          if (!/^0x[0-9a-f]{40}$/.test(w)) throw new Error("give a Polymarket wallet address (0x… 40 hex characters)");
          const j = await getJson(`${pmData}/positions?user=${w}&limit=50`);
          const pos = (j.data || []).sort((a, b) => (b.current_value || 0) - (a.current_value || 0));
          if (!pos.length) return { text: `${w} has no Polymarket positions.`, data: [] };
          const value = pos.reduce((a, p) => a + (p.current_value || 0), 0);
          const pnl = pos.reduce((a, p) => a + (p.total_pnl || 0), 0);
          const rows = pos.map((p) => ({ market: p.title, outcome: p.outcome || "", size: p.current_size, avg_price: p.avg_price, price: p.current_price, value: p.current_value, pnl: p.total_pnl, status: p.status }));
          return {
            text: `Polymarket wallet ${w}\n${pos.length} positions still held or not yet redeemed · current value ${usd(value)} · their PnL ${usd(pnl)}\n(positions already redeemed are not listed, so this is not the wallet's lifetime PnL)\n\n` + rows.slice(0, 12).map((r) => `• ${r.market}${r.outcome ? ` (${r.outcome})` : ""}: ${num(r.size, 0)} shares @ ${r.avg_price?.toFixed(3)} → ${r.price?.toFixed(3)} · value ${usd(r.value)} · PnL ${usd(r.pnl)}${r.status ? ` · ${r.status.toLowerCase()}` : ""}`).join("\n") + (rows.length > 12 ? `\n…and ${rows.length - 12} more in the data.` : "") + "\n\nSource: Polymarket Data API.",
            data: rows,
          };
        },
      },
    ],
  },
  {
    id: "near-whale-watch",
    name: "NEAR Whale Watch",
    description: "Who holds a NEAR token and what any NEAR account holds, from FastNEAR's indexer and live prices.",
    skills: [
      {
        id: "top-holders",
        name: "Token whales",
        category: "whales",
        description: "The biggest holders of a NEAR token, their share of the supply and USD value. Exchanges, bridges and DeFi contracts are labelled.",
        examples: ["wrap.near", "usdc"],
        inputSchema: { type: "object", required: ["token"], properties: { token: { type: "string", description: "Token contract or symbol, e.g. wrap.near or USDC" }, limit: { type: "integer", default: 10, description: "How many (1-25)" } } },
        async run({ token, limit = 10 }) {
          const t = await resolveToken(token);
          const n = Math.min(25, Math.max(1, Number(limit) || 10));
          const [top, supply] = await Promise.all([getJson(`https://api.fastnear.com/v1/ft/${t.id}/top`), view(t.id, "ft_total_supply").catch(() => null)]);
          const total = supply ? units(supply, t.decimals) : null;
          const rows = (top.accounts || []).slice(0, n).map((a) => {
            const amount = units(a.balance, t.decimals);
            return { account: a.account_id, amount, share: total ? amount / total : null, usd: t.price ? amount * t.price : null, kind: label(a.account_id) };
          });
          const top10 = rows.slice(0, 10).reduce((a, r) => a + (r.share || 0), 0);
          return {
            text: `${t.symbol} (${t.id}) biggest holders${total ? ` · supply ${num(total)}` : ""}${t.price ? ` · price ${usd(t.price)}` : ""}:\n\n` + rows.map((r, i) => `${i + 1}. ${r.account}${r.kind ? ` [${r.kind}]` : ""}: ${num(r.amount)} ${t.symbol}${r.share !== null ? ` (${pct(r.share)})` : ""}${r.usd !== null ? ` · ${usd(r.usd)}` : ""}`).join("\n") + (total ? `\n\nTop 10 hold ${pct(top10)} of the supply.` : "") + "\nSources: FastNEAR holders API, NEAR RPC, Rhea prices.",
            data: { token: t, holders: rows },
          };
        },
      },
      {
        id: "portfolio",
        name: "NEAR wallet portfolio",
        category: "whales",
        description: "Everything a NEAR account holds: NEAR, tokens with USD values, staking and NFTs.",
        examples: ["root.near"],
        inputSchema: { type: "object", required: ["account"], properties: { account: { type: "string", description: "NEAR account, e.g. alice.near" } } },
        async run({ account }) {
          const id = needAccount(account);
          const [full, prices] = await Promise.all([getJson(`https://api.fastnear.com/v1/account/${id}/full`), refPrices().catch(() => ({}))]);
          const nearPrice = Number(prices["wrap.near"]?.price) || null;
          const near = units(full.state?.balance || "0", 24);
          const tokens = (full.tokens || [])
            .map((t) => {
              const p = prices[t.contract_id];
              if (!p) return null;
              const amount = units(t.balance || "0", p.decimal);
              return { token: t.contract_id, symbol: p.symbol || t.contract_id.split(".")[0], amount, usd: amount * Number(p.price) };
            })
            .filter((x) => x && x.amount > 0)
            .sort((a, b) => b.usd - a.usd);
          const total = near * (nearPrice || 0) + tokens.reduce((a, t) => a + t.usd, 0);
          return {
            text: `${id}\nNEAR: ${num(near, 3)} (${usd(near * (nearPrice || 0))})${full.state?.locked && full.state.locked !== "0" ? ` · staked as validator ${num(units(full.state.locked, 24))}` : ""}\nTokens with a price: ${tokens.length} · NFT contracts: ${(full.nfts || []).length} · staking pools: ${(full.pools || []).length}\nTotal priced value ≈ ${usd(total)}\n\n` + tokens.slice(0, 15).map((t) => `• ${num(t.amount, 4)} ${t.symbol} (${t.token}) ≈ ${usd(t.usd)}`).join("\n") + ((full.pools || []).length ? `\n\nStaking pools: ${full.pools.map((p) => p.pool_id).join(", ")}` : "") + "\n\nSources: FastNEAR account API, Rhea prices.",
            data: { account: id, near, tokens, pools: full.pools || [], nft_contracts: (full.nfts || []).map((n) => n.contract_id), total_usd: total },
          };
        },
      },
    ],
  },
  {
    id: "near-market-data",
    name: "NEAR Market Data",
    description: "Live prices of NEAR and cross-chain tokens, and swap quotes through NEAR Intents (1Click).",
    skills: [
      {
        id: "prices",
        name: "Token prices",
        category: "data",
        description: "Live USD prices of one or more tokens (NEAR tokens and anything NEAR Intents can swap).",
        examples: ["NEAR, ETH, USDC"],
        inputSchema: { type: "object", required: ["tokens"], properties: { tokens: { type: "string", description: "Symbols or NEAR contract ids, comma separated" } } },
        async run({ tokens }) {
          const want = String(tokens || "").split(/[,\s]+/).map((x) => x.trim()).filter(Boolean).slice(0, 15);
          if (!want.length) throw new Error("which tokens?");
          const list = await intentTokens();
          const rows = [];
          for (const w of want) {
            const l = w.toLowerCase() === "near" ? "wnear" : w.toLowerCase();
            const hits = list.filter((t) => t.symbol.toLowerCase() === l || t.contractAddress?.toLowerCase() === l);
            if (hits.length) {
              const best = hits.find((h) => h.blockchain === "near") || hits[0];
              rows.push({ token: w, symbol: best.symbol, price: best.price, chains: [...new Set(hits.map((h) => h.blockchain))], updated: best.priceUpdatedAt });
            } else {
              const t = await resolveToken(w).catch(() => null);
              rows.push({ token: w, symbol: t?.symbol || w, price: t?.price ?? null, chains: t ? ["near"] : [], updated: null });
            }
          }
          return { text: rows.map((r) => `${r.symbol}: ${r.price !== null && r.price !== undefined ? `$${r.price >= 1 ? r.price.toFixed(2) : Number(r.price).toPrecision(4)}` : "not found"}${r.chains.length ? ` (on ${r.chains.join(", ")})` : ""}`).join("\n") + "\n\nSources: NEAR Intents 1Click token list, Rhea prices.", data: rows };
        },
      },
      {
        id: "swap-quote",
        name: "Best swap quote (NEAR Intents)",
        category: "defi",
        description: "What you would get swapping one token for another right now through NEAR Intents solvers, across chains, with the minimum after slippage and the time estimate. A quote only: nothing is executed.",
        examples: ["10 NEAR to USDC"],
        inputSchema: { type: "object", required: ["from", "to", "amount"], properties: { from: { type: "string", description: "Token you give (symbol)" }, to: { type: "string", description: "Token you get (symbol)" }, amount: { type: "number", description: "Amount you give" }, to_chain: { type: "string", description: "Chain of the token you get (optional, e.g. near, eth, base, sol)" } } },
        async run({ from, to, amount, to_chain }) {
          const list = await intentTokens();
          const find = (s, chain) => {
            const l = String(s || "").toLowerCase() === "near" ? "wnear" : String(s || "").toLowerCase();
            const hits = list.filter((t) => t.symbol.toLowerCase() === l);
            return hits.find((h) => (chain ? h.blockchain === String(chain).toLowerCase() : h.blockchain === "near")) || hits[0];
          };
          const a = find(from, "near");
          const b = find(to, to_chain);
          if (!a || !b) throw new Error(`NEAR Intents doesn't list ${!a ? from : to}`);
          const amt = Number(amount);
          if (!(amt > 0)) throw new Error("give an amount above 0");
          const raw = BigInt(Math.round(amt * 1e6)) * 10n ** BigInt(a.decimals) / 1_000_000n;
          const q = await getJson("https://1click.chaindefuser.com/v0/quote", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100, originAsset: a.assetId, depositType: "INTENTS", destinationAsset: b.assetId, amount: raw.toString(), refundTo: "intents.near", refundType: "INTENTS", recipient: "intents.near", recipientType: "INTENTS", deadline: new Date(Date.now() + 3600_000).toISOString() }),
          });
          const x = q.quote || {};
          return {
            text: `Swap ${amt} ${a.symbol} (${a.blockchain}) → ${b.symbol} (${b.blockchain}) through NEAR Intents:\nYou get ≈ ${x.amountOutFormatted} ${b.symbol} (${usd(Number(x.amountOutUsd))}) for ${usd(Number(x.amountInUsd))} in\nMinimum after 1% slippage: ${units(x.minAmountOut || "0", b.decimals)} ${b.symbol}\nTime ≈ ${x.timeEstimate ?? "?"} s\n\nA live solver quote, not executed. Source: NEAR Intents 1Click API.`,
            data: { from: a.assetId, to: b.assetId, amount_in: x.amountInFormatted, amount_out: x.amountOutFormatted, min_out: x.minAmountOut, usd_in: x.amountInUsd, usd_out: x.amountOutUsd, seconds: x.timeEstimate },
          };
        },
      },
    ],
  },
  {
    id: "rhea-yield-scout",
    name: "Rhea Yield Scout",
    description: "Where NEAR DeFi pays: Rhea Lending (Burrow) supply and borrow rates read from the contract, and Rhea's biggest pools.",
    skills: [
      {
        id: "lending-rates",
        name: "Lending rates on Rhea (Burrow)",
        category: "yield",
        description: "Supply and borrow APR of every Burrow market with its size and utilization, straight from the lending contract.",
        examples: ["best supply rates"],
        inputSchema: { type: "object", properties: { sort: { type: "string", enum: ["supply", "borrow", "size"], default: "supply", description: "Sort by" } } },
        async run({ sort = "supply" }) {
          const [assets, prices] = await Promise.all([view("contract.main.burrow.near", "get_assets_paged_detailed", { from_index: 0, limit: 100 }), refPrices().catch(() => ({}))]);
          const rows = [];
          for (const a of assets) {
            const p = prices[a.token_id];
            const decimals = (p?.decimal ?? (await metaOf(a.token_id).catch(() => ({ decimals: 18 }))).decimals) + (a.config.extra_decimals || 0);
            const supplied = units(a.supplied.balance, decimals) + units(a.reserved || "0", decimals);
            const borrowed = units(a.borrowed.balance, decimals);
            rows.push({ token: a.token_id, symbol: p?.symbol || a.token_id.slice(0, 12), supply_apr: Number(a.supply_apr), borrow_apr: Number(a.borrow_apr), supplied_usd: p ? supplied * Number(p.price) : null, utilization: supplied ? borrowed / supplied : 0, can_deposit: a.config.can_deposit });
          }
          const live = rows.filter((r) => r.can_deposit && (r.supplied_usd ?? 0) > 1000);
          live.sort((x, y) => (sort === "borrow" ? x.borrow_apr - y.borrow_apr : sort === "size" ? (y.supplied_usd ?? 0) - (x.supplied_usd ?? 0) : y.supply_apr - x.supply_apr));
          return {
            text: `Rhea Lending (Burrow) markets, by ${sort === "borrow" ? "cheapest borrow" : sort === "size" ? "size" : "best supply APR"}:\n\n` + live.slice(0, 15).map((r) => `• ${r.symbol}: supply ${pct(r.supply_apr)} · borrow ${pct(r.borrow_apr)} · size ${usd(r.supplied_usd)} · used ${pct(r.utilization)}`).join("\n") + "\n\nBase APRs from contract.main.burrow.near (farm rewards not included). Sizes priced with Rhea prices.",
            data: live,
          };
        },
      },
      {
        id: "top-pools",
        name: "Biggest Rhea pools",
        category: "yield",
        description: "Rhea's (Ref Finance) pools by TVL, with their fee, optionally holding one token.",
        examples: ["NEAR"],
        inputSchema: { type: "object", properties: { token: { type: "string", description: "Only pools with this token (optional)" }, limit: { type: "integer", default: 10, description: "How many (1-25)" } } },
        async run({ token, limit = 10 }) {
          const pools = await cached("ref-pools", 120_000, () => getJson("https://api.ref.finance/list-top-pools"));
          const t = String(token || "").toLowerCase().replace(/^near$/, "wnear");
          const pick = pools.filter((p) => !t || p.token_symbols.some((s) => s.toLowerCase() === t) || p.token_account_ids.includes(t)).sort((a, b) => Number(b.tvl) - Number(a.tvl)).slice(0, Math.min(25, Math.max(1, Number(limit) || 10)));
          const rows = pick.map((p) => ({ id: p.id, pair: p.token_symbols.join("/"), tvl: Number(p.tvl), fee: p.total_fee / 10000, kind: p.pool_kind, farming: p.farming }));
          return { text: `Biggest Rhea pools${token ? ` with ${token}` : ""}:\n\n` + rows.map((r, i) => `${i + 1}. #${r.id} ${r.pair}: TVL ${usd(r.tvl)} · fee ${pct(r.fee)}${r.farming ? " · farm" : ""} (${r.kind.toLowerCase().replace(/_/g, " ")})`).join("\n") + "\n\nSource: Rhea (Ref Finance) API.", data: rows };
        },
      },
    ],
  },
  {
    id: "burrow-risk-guard",
    name: "Burrow Risk Guard",
    description: "Liquidation risk of a Rhea Lending (Burrow) account: collateral, debt, health factor and how far prices can fall.",
    skills: [
      {
        id: "health-factor",
        name: "Liquidation check (Burrow)",
        category: "risk",
        description: "A Burrow account's collateral and debt in USD, its health factor (liquidation below 100%), and how much its collateral can drop before liquidation.",
        examples: ["alice.near"],
        inputSchema: { type: "object", required: ["account"], properties: { account: { type: "string", description: "NEAR account with a Burrow position" } } },
        async run({ account }) {
          const id = needAccount(account);
          const acc = await view("contract.main.burrow.near", "get_account", { account_id: id });
          if (!acc) return { text: `${id} has no Rhea Lending (Burrow) account.`, data: null };
          const prices = await refPrices().catch(() => ({}));
          const cfg = new Map();
          const conf = async (t) => {
            if (!cfg.has(t)) cfg.set(t, (await view("contract.main.burrow.near", "get_asset", { token_id: t })).config);
            return cfg.get(t);
          };
          const line = async (x) => {
            const c = await conf(x.token_id);
            const p = prices[x.token_id];
            const dec = (p?.decimal ?? (await metaOf(x.token_id)).decimals) + (c.extra_decimals || 0);
            const amount = units(x.balance, dec);
            return { token: x.token_id, symbol: p?.symbol || x.token_id.slice(0, 12), amount, usd: p ? amount * Number(p.price) : 0, vol: c.volatility_ratio / 10000, priced: !!p };
          };
          const pos = acc.positions?.REGULAR || acc.positions?.regular || Object.values(acc.positions || {})[0] || {};
          const col = await Promise.all((pos.collateral || acc.collateral || []).map(line));
          const debt = await Promise.all((pos.borrowed || acc.borrowed || []).map(line));
          const adjCol = col.reduce((a, x) => a + x.usd * x.vol, 0);
          const adjDebt = debt.reduce((a, x) => a + x.usd / x.vol, 0);
          const hf = adjDebt ? adjCol / adjDebt : null;
          const verdict = hf === null ? "no debt: nothing to liquidate" : hf < 1 ? "LIQUIDATABLE now" : hf < 1.1 ? "danger: close to liquidation" : hf < 1.5 ? "watch it" : "safe";
          const room = hf && hf > 1 ? 1 - 1 / hf : null;
          return {
            text: `${id} on Rhea Lending (Burrow)\nCollateral ${usd(col.reduce((a, x) => a + x.usd, 0))} · debt ${usd(debt.reduce((a, x) => a + x.usd, 0))}\nHealth factor: ${hf === null ? "∞" : pct(hf)} → ${verdict}${room !== null ? `\nCollateral value can fall about ${pct(room)} (with debt prices unchanged) before liquidation.` : ""}\n\nCollateral:\n${col.map((x) => `• ${num(x.amount, 4)} ${x.symbol} ≈ ${usd(x.usd)} (counts ${pct(x.vol)})`).join("\n") || "• none"}\nDebt:\n${debt.map((x) => `• ${num(x.amount, 4)} ${x.symbol} ≈ ${usd(x.usd)}`).join("\n") || "• none"}${[...col, ...debt].some((x) => !x.priced) ? "\n\nSome tokens have no Rhea price and count as $0." : ""}\n\nPositions and risk ratios from contract.main.burrow.near; prices from Rhea, which can differ slightly from Burrow's oracle.`,
            data: { account: id, health_factor: hf, verdict, collateral: col, debt },
          };
        },
      },
    ],
  },
  {
    id: "token-check",
    name: "NEP-141 Token Check",
    description: "Due diligence for any NEAR token: supply, holder concentration, who can upgrade the contract, and red flags.",
    skills: [
      {
        id: "token-dd",
        name: "Token due diligence",
        category: "research",
        description: "Before you buy a NEAR token: its metadata and supply, how concentrated its holders are, whether someone holds a full-access key to its contract (and can change it), the contract's code hash, price and red flags.",
        examples: ["token.burrow.near"],
        inputSchema: { type: "object", required: ["token"], properties: { token: { type: "string", description: "Token contract id (or symbol)" } } },
        async run({ token }) {
          const t = await resolveToken(token);
          const [meta, supply, acct, keys, top] = await Promise.all([
            metaOf(t.id),
            view(t.id, "ft_total_supply").catch(() => null),
            rpcQuery({ request_type: "view_account", account_id: t.id }),
            rpcQuery({ request_type: "view_access_key_list", account_id: t.id }),
            getJson(`https://api.fastnear.com/v1/ft/${t.id}/top`).catch(() => ({ accounts: [] })),
          ]);
          const total = supply ? units(supply, meta.decimals) : null;
          const holders = (top.accounts || []).slice(0, 10).map((a) => ({ account: a.account_id, share: total ? units(a.balance, meta.decimals) / total : null, kind: label(a.account_id) }));
          const top1 = holders[0]?.share ?? null;
          const top10 = holders.reduce((a, h) => a + (h.share || 0), 0);
          const full = keys.keys.filter((k) => k.access_key.permission === "FullAccess").length;
          const flags = [];
          if (full > 0) flags.push(`${full} full-access key${full > 1 ? "s" : ""} on the contract: whoever holds ${full > 1 ? "them" : "it"} can redeploy the code, mint or freeze.`);
          if (acct.code_hash === "11111111111111111111111111111111") flags.push("No contract code on this account.");
          if (top1 !== null && top1 > 0.5 && !holders[0].kind) flags.push(`One wallet (${holders[0].account}) holds ${pct(top1)} of the supply.`);
          if (top10 > 0.9) flags.push(`The top 10 holders hold ${pct(top10)}.`);
          if (t.price === null) flags.push("No Rhea price: no liquid market on Rhea.");
          return {
            text: `${meta.name} (${meta.symbol}) · ${t.id}\nDecimals ${meta.decimals} · supply ${total !== null ? num(total) : "—"}${t.price ? ` · price ${usd(t.price)} · market cap ≈ ${usd(total * t.price)}` : ""}\nContract code hash ${acct.code_hash} · storage ${(acct.storage_usage / 1e6).toFixed(2)} MB\nFull-access keys on the contract: ${full} (${full ? "upgradeable by a key holder" : "locked: no one holds a key"})\nTop holder ${top1 !== null ? pct(top1) : "—"} · top 10 ${pct(top10)}\n\nRed flags:\n${flags.length ? flags.map((f) => `• ${f}`).join("\n") : "• none found"}\n\nTop holders:\n${holders.map((h, i) => `${i + 1}. ${h.account}${h.kind ? ` [${h.kind}]` : ""} ${h.share !== null ? pct(h.share) : ""}`).join("\n")}\n\nSources: NEAR RPC (metadata, supply, account, keys), FastNEAR holders, Rhea prices. Not financial advice.`,
            data: { token: t.id, name: meta.name, symbol: meta.symbol, decimals: meta.decimals, supply: total, price: t.price, code_hash: acct.code_hash, full_access_keys: full, top_holder_share: top1, top10_share: top10, flags, holders },
          };
        },
      },
    ],
  },
];

// Well-known contracts, so a list of holders reads right.
function label(id) {
  if (/^(intents\.near|omni\.bridge\.near|aurora|factory\.bridge\.near)$/.test(id) || id.endsWith(".factory.bridge.near")) return "bridge / intents";
  if (/burrow\.near$|ref-finance\.near$|rhea|veax|tonic|orderly|spin|dclv2|\.pool\./.test(id)) return "DeFi contract";
  if (/binance|okx|huobi|htx|kucoin|gate|bybit|coinbase|kraken|bitget|mexc/.test(id)) return "exchange";
  if (/^[0-9a-f]{64}$/.test(id)) return "";
  return "";
}

const byId = new Map(AGENTS.map((a) => [a.id, a]));
const card = (a) => ({ id: a.id, name: a.name, description: a.description, skills: a.skills.map(({ id, name, category, description, examples, inputSchema }) => ({ id, name, category, description, examples, inputSchema })) });
const list = () => AGENTS.map(card);
function get(id) {
  const a = byId.get(String(id || "").replace(/^official:/, ""));
  if (!a) throw new Error(`no official agent ${id}`);
  return a;
}

module.exports = { list, get, card, AGENTS };
