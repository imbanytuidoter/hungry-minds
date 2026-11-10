import type { SearchItem } from "@/components/docs/DocsFrame";
import { GUIDE, GUIDE_LEAD_TEXT, GUIDE_TITLE } from "./guide";
import { PAGES, pageHref } from "./pages";

/** One search entry per page and per section, across the docs and the player guide. */
export const SEARCH: SearchItem[] = [
  ...PAGES.flatMap((p) => [
    { href: pageHref(p.slug), title: p.title, page: p.group, text: p.leadText },
    ...p.sections.map((s) => ({ href: `${pageHref(p.slug)}#${s.id}`, title: s.title, page: `${p.group} / ${p.title}`, text: s.summary })),
  ]),
  { href: "/guide", title: GUIDE_TITLE, page: "Guide", text: GUIDE_LEAD_TEXT },
  ...GUIDE.map((s) => ({ href: `/guide#${s.id}`, title: s.title, page: `Guide`, text: s.summary })),
];
