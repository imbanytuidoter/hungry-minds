import type { Metadata } from "next";
import Link from "next/link";
import DocArticle from "@/components/docs/DocArticle";
import DocsFrame from "@/components/docs/DocsFrame";
import { GUIDE, GUIDE_LEAD_TEXT, GUIDE_TITLE } from "@/lib/docs/guide";
import { SEARCH } from "@/lib/docs/search";

export const metadata: Metadata = {
  title: "Player guide · Hungry Minds",
  description: GUIDE_LEAD_TEXT,
};

const NAV = [
  { title: "Player guide", items: GUIDE.map((s) => ({ href: `#${s.id}`, title: s.title })) },
  {
    title: "Go deeper",
    items: [
      { href: "/docs", title: "Docs home" },
      { href: "/docs/fees", title: "Fees and splits" },
      { href: "/docs/agents", title: "Agents and services" },
      { href: "/docs/faq", title: "FAQ" },
    ],
  },
];

export default function Guide() {
  return (
    <DocsFrame current="guide" nav={NAV} search={SEARCH} toc={GUIDE.map((s) => ({ id: s.id, title: s.title }))} outline={false}>
      <DocArticle
        crumbs={[{ title: "Guide" }]}
        title={GUIDE_TITLE}
        lead={GUIDE_LEAD_TEXT}
        sections={GUIDE}
        end={
          <div className="hd-cards">
            <Link className="hd-card" href="/app">
              <b>Open the game</b>
              <span>Hatch a Mind or look around the colony first.</span>
            </Link>
            <Link className="hd-card" href="/docs">
              <b>Read the docs</b>
              <span>Every rule, fee and contract detail in one place.</span>
            </Link>
          </div>
        }
      />
    </DocsFrame>
  );
}
