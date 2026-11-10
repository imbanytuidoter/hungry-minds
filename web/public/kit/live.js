// Live data from the Hungry Minds testnet contract, straight from a NEAR RPC in the browser.
// Usage: <script src="../kit/live.js"></script>  then  const d = await HM.live();
// Returns real numbers only. Never replace a failed read with an invented number: show "—" or hide.
(function () {
  const CONTRACT = "hungry-minds-8250f6.testnet";
  const RPCS = ["https://near-testnet.drpc.org", "https://rpc.testnet.near.org"];
  const YOCTO = 10n ** 24n;

  async function view(method, args) {
    let last;
    for (const rpc of RPCS) {
      try {
        const body = { jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args || {})) } };
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json());
        if (!r.result) throw new Error("rpc error");
        return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)));
      } catch (e) {
        last = e;
      }
    }
    throw last;
  }

  const near = (yocto) => Number(BigInt(yocto) / 10n ** 18n) / 1e6; // NEAR with 6 decimals

  function chatLine(t) {
    if (!t) return null;
    const one = String(t).replace(/\s+/g, " ").trim();
    if (!one || /\b[\w-]+\.(near|testnet)\b|\$\d|health factor|collateral|\bdebt\b|→/i.test(one)) return null;
    return one;
  }

  /** { totalMinds, supplyLeft, ghostWindowMs, minds: [{ id, name, balance, state, thoughts, ghost, lastReply, svg }] } */
  async function live() {
    const s = await view("colony_snapshot", {});
    let tokens = [];
    try {
      tokens = await view("nft_tokens", { from_index: "0", limit: 60 });
    } catch (e) {
      /* pictures are optional */
    }
    const pic = {};
    for (const t of tokens) {
      const m = (t.metadata && t.metadata.media) || "";
      if (m.startsWith("data:image/svg+xml")) pic[t.token_id] = m;
    }
    return {
      contract: CONTRACT,
      totalMinds: s.total_minds,
      supplyLeft: s.supply_left,
      ghostWindowMs: s.ghost_window_ms,
      minds: s.minds.map((r) => ({
        id: r.id,
        name: r.mind.name,
        balance: near(r.live_balance),
        state: r.live_state, // full | content | hungry | starving | asleep | ghost
        thoughts: r.mind.thought_count,
        ghost: r.mind.ghost,
        // only a chat line: a job result written for a buyer (account ids, dollar figures, data) is not hers to show
        lastReply: chatLine(r.mind.last_reply),
        svg: pic[String(r.id)] || null, // data: URI of her on-chain NFT picture
      })),
    };
  }

  window.HM = { live, view, CONTRACT, GAME: "/app", GUIDE: "/guide", NEARBLOCKS: "https://testnet.nearblocks.io/address/" + CONTRACT };
})();
