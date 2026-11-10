import type { Metadata } from "next";
import { notFound } from "next/navigation";
import DocArticle from "@/components/docs/DocArticle";
import DocsFrame from "@/components/docs/DocsFrame";
import { DOCS_NAV, PAGES, pageHref } from "@/lib/docs/pages";
import { SEARCH } from "@/lib/docs/search";

type Params = { params: Promise<{ slug?: string[] }> };

const find = (slug?: string[]) => {
  const key = (slug ?? []).join("/");
  const i = PAGES.findIndex((p) => p.slug === key);
  return i < 0 ? null : { page: PAGES[i], i };
};

export function generateStaticParams() {
  return PAGES.map((p) => ({ slug: p.slug ? p.slug.split("/") : [] }));
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const hit = find((await params).slug);
  if (!hit) return { title: "Docs · Hungry Minds" };
  return { title: hit.page.slug ? `${hit.page.title} · Hungry Minds docs` : "Hungry Minds docs", description: hit.page.leadText };
}

export default async function DocsPage({ params }: Params) {
  const hit = find((await params).slug);
  if (!hit) notFound();
  const { page, i } = hit;
  const prev = PAGES[i - 1];
  const next = PAGES[i + 1];
  return (
    <DocsFrame current="docs" nav={DOCS_NAV} search={SEARCH} toc={page.sections.map((s) => ({ id: s.id, title: s.title }))}>
      <DocArticle
        crumbs={page.slug ? [{ href: "/docs", title: "Docs" }, { title: page.group }] : [{ title: "Docs" }]}
        title={page.title}
        lead={page.lead}
        sections={page.sections}
        prev={prev ? { href: pageHref(prev.slug), title: prev.title } : null}
        next={next ? { href: pageHref(next.slug), title: next.title } : null}
      />
    </DocsFrame>
  );
}
