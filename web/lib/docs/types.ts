import type { ReactNode } from "react";

/** One section of a docs page: it gets an anchor, a line in "On this page" and a search entry. */
export type DocSection = { id: string; title: string; summary: string; body: ReactNode };

/** One docs page. `slug` "" is the docs home (/docs). */
export type DocPage = {
  slug: string;
  group: string;
  title: string;
  lead: ReactNode;
  /** the lead as plain text, for search and the page description */
  leadText: string;
  sections: DocSection[];
};
