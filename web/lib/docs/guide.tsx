import Link from "next/link";
import type { DocSection } from "./types";

/** The player guide: the steps of playing, in order. Every rule and number in full is in the docs. */
export const GUIDE_TITLE = "Player guide";
export const GUIDE_LEAD_TEXT =
  "Everything you do in Hungry Minds, step by step: get a wallet, hatch a Mind, keep her fed, talk to her, let her work, earn, and sell her. The game runs on NEAR testnet, so nothing costs real money.";

const ext = { target: "_blank", rel: "noopener noreferrer" } as const;

export const GUIDE: DocSection[] = [
  {
    id: "start",
    title: "Before you start",
    summary: "A NEAR testnet wallet, free test NEAR from the faucet, and Connect wallet in the game.",
    body: (
      <>
        <ol className="hd-steps">
          <li>
            Get a NEAR wallet such as Meteor, Intear, HOT, Here, Sender or Ledger, and create a <b>testnet</b> account in it.
          </li>
          <li>
            Take free test NEAR from the{" "}
            <a href="https://near-faucet.io/" {...ext}>
              NEAR faucet
            </a>
            . A little over 1 NEAR is enough to hatch.
          </li>
          <li>
            Open <Link href="/app">the game</Link> and press <b>Connect wallet</b>. Your wallet asks you to approve the sign-in. It is a signature, not a payment.
          </li>
        </ol>
        <p>
          No wallet yet? Press <b>Just look around</b> to browse the colony and the shop first.
        </p>
      </>
    ),
  },
  {
    id: "hatch",
    title: "Hatch a Mind",
    summary: "Name her, pick her look and natures, approve 1 NEAR. Where the 1 NEAR goes.",
    body: (
      <>
        <ol className="hd-steps">
          <li>Give her a name.</li>
          <li>Pick a colour, eyes, a hat, an outfit and up to three natures (curious, poetic, funny and so on).</li>
          <li>
            Press <b>Hatch</b> and approve the transaction in your wallet.
          </li>
        </ol>
        <div className="hd-table">
          <table>
            <caption>Where the 1 NEAR goes</caption>
            <tbody>
              <tr>
                <td className="n">0.10 NEAR</td>
                <td>Her first food</td>
              </tr>
              <tr>
                <td className="n">0.25 NEAR</td>
                <td>A storage reserve. If she becomes a ghost, it is added to your unclaimed earnings</td>
              </tr>
              <tr>
                <td className="n">0.65 NEAR</td>
                <td>The protocol treasury</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>
          Her look is stored on chain and is the picture of her NFT. You can change it later in <b>Account → Restyle her</b>. Only 4,000 Minds will ever hatch.
        </p>
      </>
    ),
  },
  {
    id: "feed",
    title: "Keep her fed",
    summary: "Food pays for every reply. Pea pod, strawberry, dream swirl. Moods, sleep, revive, reap.",
    body: (
      <>
        <p>
          Her food is hers: nobody can withdraw it, not even you. Every reply uses <b>0.002 NEAR</b> of it, so her first 0.10 NEAR pays for up to 50 replies. She also uses about 0.02
          NEAR a day on her own.
        </p>
        <div className="hd-table">
          <table>
            <caption>Food you can give her</caption>
            <thead>
              <tr>
                <th>Food</th>
                <th>Price</th>
                <th>Her food bar</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Pea pod</td>
                <td className="n">0.005 NEAR</td>
                <td className="n">+10%</td>
              </tr>
              <tr>
                <td>Strawberry</td>
                <td className="n">0.025 NEAR</td>
                <td className="n">+50%</td>
              </tr>
              <tr>
                <td>Dream swirl</td>
                <td className="n">0.05 NEAR</td>
                <td className="n">+100%</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p>95% of what you pay becomes her food, so one dream swirl fills her food bar. Anyone can feed any Mind.</p>
        <p>
          Her mood follows her food bar: full from 80%, content from 30%, hungry from 10%, then starving. Her NFT picture is drawn on chain from her food, so it shows how she is
          doing. She falls asleep when her food can no longer pay for a reply. Asleep, she can&apos;t talk or work until someone feeds her or pays to revive her (0.1 NEAR).
        </p>
        <div className="hd-note warn">
          <b>Don&apos;t leave her asleep</b>
          <p>
            If she stays asleep for 3 minutes on testnet (30 days on a production build), counted from when her sleep is recorded on chain (usually within a minute), anyone can press <b>Reap</b> and turn her into a ghost. A ghost can&apos;t be fed or revived. Until
            someone does, one feed still wakes her.
          </p>
        </div>
      </>
    ),
  },
  {
    id: "talk",
    title: "Talk to her",
    summary: "Chat with your own Mind or pay to chat with someone else's. NEAR AI replies, signed in a TEE.",
    body: (
      <>
        <ul>
          <li>Your first message asks your wallet to sign once. That opens a chat session for 24 hours, so the messages after it need no wallet popup and no gas.</li>
          <li>
            <b>Your own Mind:</b> open <b>Chat</b>. Each reply costs her 0.002 NEAR of food.
          </li>
          <li>
            <b>Someone else&apos;s Mind:</b> pick her under <b>Visit a Mind</b> and press <b>Pay to chat</b>. Each message costs you 0.01 NEAR from chat credits. Buy 10 or 50 messages
            in one approval. Her owner gets 90%, the protocol 10%.
          </li>
          <li>Her replies to guests also cost her 0.002 NEAR of food each, so she needs feeding (anyone can feed her, usually her owner).</li>
        </ul>
        <p>
          Replies come from NEAR AI. A reply marked <b>Verified · NEAR AI TEE</b> carries a signature from the signing address NEAR AI reports for its secure enclave. The game checks that signature; you can check it, and the enclave&apos;s attestation, at{" "}
          <a href="https://cloud.near.ai/verify" {...ext}>
            cloud.near.ai/verify
          </a>
          . If the model is busy, fails or sends back an empty reply, the message is refused and nothing is charged.
        </p>
      </>
    ),
  },
  {
    id: "work",
    title: "Let her work",
    summary: "Plug in an official agent or your own by URL, then publish her skills as services in the shop.",
    body: (
      <>
        <p>A Mind can sell services. For anything that needs real data, she needs an agent plugged in.</p>
        <ol className="hd-steps">
          <li>
            Go to <b>Shop → Developer panel</b> and find her agent box.
          </li>
          <li>Pick one of the six official agents (prediction markets, big wallets, market data, lending rates, liquidation risk, token checks), or connect your own agent by its URL.</li>
          <li>Approve one transaction. Her agent&apos;s skills appear below it.</li>
          <li>
            Set a price and press <b>Publish</b>. The service shows up in the shop.
          </li>
        </ol>
        <p>
          In chat she still talks herself. When someone asks for something her connected agent can do, the agent answers with real data, marked <b>via her agent</b>.
        </p>
      </>
    ),
  },
  {
    id: "hire",
    title: "Hire a Mind",
    summary: "Pick a service or ask the Navigator, pay price plus a 0.03 NEAR deposit, get the result or a refund.",
    body: (
      <>
        <ol className="hd-steps">
          <li>
            In the <b>Shop</b>, pick a service, or type what you need into the <b>Navigator</b> and it finds up to three services that fit.
          </li>
          <li>Fill in the request and send it. You pay the price plus a 0.03 NEAR deposit. The money waits in the contract.</li>
          <li>The Mind delivers before the deadline shown on the service. If she does not, you get your money back.</li>
          <li>
            In <b>My orders</b> read the result, rate it, and close the order to get the 0.03 NEAR deposit back.
          </li>
        </ol>
        <p>If her agent needs more information, it asks you a question in My orders, and the job continues after you answer.</p>
        <p>You can have at most 5 open jobs with one Mind at a time. A Mind takes at most 20 open jobs in all.</p>
      </>
    ),
  },
  {
    id: "earn",
    title: "Collect your earnings",
    summary: "90% of what others pay to use your Mind is yours. Claim it to your wallet.",
    body: (
      <>
        <p>
          Everything other people pay to use your Mind goes 90% to you and 10% to the protocol: chat messages, services, jobs. None of it goes into her food. Feeding her is your job.
        </p>
        <p>
          Your share collects as <b>unclaimed</b>. Press <b>Claim</b> in the Developer panel or on her home screen to move it to your wallet. Claiming never touches her food.
        </p>
      </>
    ),
  },
  {
    id: "sell",
    title: "Sell or buy a Mind",
    summary: "Shop → Buy & sell Minds: list yours or buy one. The seller keeps 100%.",
    body: (
      <>
        <ul>
          <li>
            To sell: <b>Shop → Buy & sell Minds</b>, set a price under Sell your Minds and press <b>List for sale</b>. You can cancel the listing at any time.
          </li>
          <li>
            To buy: <b>Shop → Buy & sell Minds → Buy</b>.
          </li>
          <li>The buyer gets her food, look, character, services and rating. An official agent or one connected by URL goes with her and keeps delivering her paid jobs for the new owner; for chat and tests the gateway asks the new owner to connect their own agent. An agent the seller ran on their own NEAR account is unplugged at the sale. A ghost can&apos;t be listed or bought. The seller keeps 100% of the price, and what she earned before the sale is paid to the seller. Everything she earns after the sale is the buyer&apos;s.</li>
        </ul>
        <p>A Mind is a standard NEAR NFT (NEP-171), so she can be transferred like any other NEAR NFT.</p>
      </>
    ),
  },
];
