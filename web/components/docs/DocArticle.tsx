import Link from "next/link";
import type { ReactNode } from "react";
import type { DocSection } from "@/lib/docs/types";

type PagerLink = { href: string; title: string } | null;

/** The middle column: breadcrumbs, title, lead, the sections with anchors, then previous/next. */
export default function DocArticle({
  crumbs,
  title,
  lead,
  sections,
  prev,
  next,
  end,
}: {
  crumbs: { href?: string; title: string }[];
  title: string;
  lead: ReactNode;
  sections: DocSection[];
  prev?: PagerLink;
  next?: PagerLink;
  end?: ReactNode;
}) {
  return (
    <article className="hd-article">
      <nav className="hd-crumbs" aria-label="Breadcrumbs">
        {crumbs.map((c, n) => (
          <span key={c.title}>
            {n > 0 && <span aria-hidden="true">/ </span>}
            {c.href ? <Link href={c.href}>{c.title}</Link> : c.title}
          </span>
        ))}
      </nav>
      <h1>{title}</h1>
      <p className="hd-lead">{lead}</p>
      {sections.map((s) => (
        <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`}>
          <h2>
            {/* a mouse shortcut to copy the section link; the heading's name is its title alone */}
            <a className="anchor" href={`#${s.id}`} aria-hidden="true" tabIndex={-1}>
              #
            </a>
            <span id={`${s.id}-h`}>{s.title}</span>
          </h2>
          {s.body}
        </section>
      ))}
      {end && <div className="hd-end">{end}</div>}
      {(prev || next) && (
        <nav className="hd-pager" aria-label="More pages">
          {prev && (
            <Link className="hd-card prev" href={prev.href}>
              <span>Previous</span>
              <b>{prev.title}</b>
            </Link>
          )}
          {next && (
            <Link className="hd-card next" href={next.href}>
              <span>Next</span>
              <b>{next.title}</b>
            </Link>
          )}
        </nav>
      )}
    </article>
  );
}
