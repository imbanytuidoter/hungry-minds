"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ModeToggle from "@/components/ModeToggle";

export type NavItem = { href: string; title: string };
export type NavGroup = { title: string; items: NavItem[] };
export type SearchItem = { href: string; title: string; page: string; text: string };
export type TocItem = { id: string; title: string };

/** The frame shared by /docs and /guide, laid out like the docs of most crypto projects:
 *  a top bar with search and the app button, grouped pages on the left, the article in the
 *  middle and an outline of the page on the right. */
export default function DocsFrame({
  current,
  nav,
  search,
  toc,
  outline = true,
  children,
}: {
  current: "docs" | "guide";
  nav: NavGroup[];
  search: SearchItem[];
  toc?: TocItem[];
  /** show the "On this page" column (the guide lists its sections on the left instead) */
  outline?: boolean;
  children: React.ReactNode;
}) {
  const showToc = outline && !!toc && toc.length > 0;
  const pathname = usePathname();
  const [menu, setMenu] = useState(false);
  const [find, setFind] = useState(false);
  const searchBtn = useRef<HTMLButtonElement>(null);
  const active = useActiveSection(toc);

  const side = useRef<HTMLElement>(null);
  useEffect(() => setMenu(false), [pathname]);
  // a result picked in search may be on this very page, so the page menu closes as search opens
  useEffect(() => {
    if (find) setMenu(false);
  }, [find]);
  // on a long sidebar the current page may sit below its fold: scroll the sidebar (not the page) to it
  useEffect(() => {
    const box = side.current;
    const a = box?.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!box || !a) return;
    if (a.offsetTop < box.scrollTop || a.offsetTop + a.offsetHeight > box.scrollTop + box.clientHeight) box.scrollTop = a.offsetTop - box.clientHeight / 2;
  }, [pathname]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setFind(true);
      } else if (e.key === "Escape") setMenu(false);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  const closeFind = useCallback(() => {
    setFind(false);
    // give focus back to where search was opened from
    requestAnimationFrame(() => searchBtn.current?.focus({ preventScroll: true }));
  }, []);

  const isOn = (href: string) => (href.startsWith("#") ? active === href.slice(1) : href === pathname);
  // a section of this page is the current location, a page link is the current page
  const current_ = (href: string) => (isOn(href) ? (href.startsWith("#") ? "location" : "page") : undefined);

  return (
    <>
      <header className="hd-top">
        <a className="hd-skip" href="#content">
          Skip to content
        </a>
        <button className="hd-menu" type="button" aria-label="Pages" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <svg viewBox="0 0 18 18" aria-hidden="true">
            {menu ? <path d="M4 4l10 10M14 4 4 14" /> : <path d="M3 5h12M3 9h12M3 13h12" />}
          </svg>
        </button>
        <Link className="hd-brand" href="/" aria-label="Hungry Minds home">
          {/* eslint-disable-next-line @next/next/no-img-element -- a vector badge */}
          <img src="/kit/brand/logo.svg" alt="" width={32} height={32} />
          <b>hungry minds</b>
          <i>{current === "docs" ? "docs" : "guide"}</i>
        </Link>
        <button ref={searchBtn} className="hd-search" type="button" onClick={() => setFind(true)} aria-label="Search the docs">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="m10.6 10.6 3.4 3.4" />
          </svg>
          <span>Search</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav className="hd-links" aria-label="Site">
          <Link href="/guide" className="hide-sm" aria-current={current === "guide" ? "page" : undefined}>
            Guide
          </Link>
          <Link href="/docs" className="hide-sm" aria-current={current === "docs" ? "page" : undefined}>
            Docs
          </Link>
          <Link className="hd-btn" href="/app">
            Open the game
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
            </svg>
          </Link>
          <ModeToggle />
        </nav>
      </header>

      <div className={`hd-body${showToc ? "" : " no-toc"}`}>
        <aside ref={side} className={`hd-side${menu ? " open" : ""}`} aria-label="Pages">
          {nav.map((g) => (
            <div className="hd-group" key={g.title}>
              <p>{g.title}</p>
              <ul>
                {g.items.map((it) => (
                  <li key={it.href}>
                    <Link href={it.href} className={isOn(it.href) ? "on" : undefined} aria-current={current_(it.href)} onClick={() => setMenu(false)}>
                      {it.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="hd-side-foot">
            {current === "docs" ? (
              <>
                New here? Start with the <Link href="/guide">player guide</Link>.
              </>
            ) : (
              <>
                Every rule and number is in the <Link href="/docs">docs</Link>.
              </>
            )}
          </div>
        </aside>
        {menu && <div className="hd-scrim" onClick={() => setMenu(false)} aria-hidden="true" />}

        <main className="hd-main" id="content">
          {children}
        </main>

        {showToc && toc && (
          <nav className="hd-toc" aria-label="On this page">
            <p>On this page</p>
            <ul>
              {toc.map((t) => (
                <li key={t.id}>
                  <a href={`#${t.id}`} className={active === t.id ? "on" : undefined} aria-current={active === t.id ? "location" : undefined}>
                    {t.title}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </div>

      {find && <SearchDialog items={search} onClose={closeFind} />}
    </>
  );
}

/** Which section of the page is being read: the last one whose heading has passed the top third.
 *  At the very bottom of a page that scrolls, the last short sections can never reach that line,
 *  so there the section the reader jumped to (the URL hash) wins, else the last one. */
function useActiveSection(toc?: TocItem[]) {
  const [active, setActive] = useState<string | null>(toc?.[0]?.id ?? null);
  useEffect(() => {
    if (!toc || !toc.length) return;
    let raf = 0;
    const pick = () => {
      raf = 0;
      const line = innerHeight * 0.3;
      let id = toc[0].id;
      for (const t of toc) {
        const el = document.getElementById(t.id);
        if (el && el.getBoundingClientRect().top <= line) id = t.id;
      }
      const doc = document.documentElement;
      const atBottom = doc.scrollHeight > innerHeight + 4 && scrollY > 0 && innerHeight + scrollY >= doc.scrollHeight - 4;
      if (atBottom) {
        const hash = decodeURIComponent(location.hash.slice(1));
        const jumped = hash && toc.some((t) => t.id === hash) ? document.getElementById(hash) : null;
        const top = jumped ? jumped.getBoundingClientRect().top : NaN;
        id = top >= -8 && top < innerHeight ? hash : toc[toc.length - 1].id;
      }
      setActive(id);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(pick);
    };
    pick();
    addEventListener("scroll", onScroll, { passive: true });
    addEventListener("resize", onScroll);
    addEventListener("hashchange", onScroll);
    return () => {
      removeEventListener("scroll", onScroll);
      removeEventListener("resize", onScroll);
      removeEventListener("hashchange", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [toc]);
  return active;
}

/** Cut text at a word boundary, with an ellipsis when it was longer. */
const clip = (t: string, n: number) => {
  if (t.length <= n) return t;
  const i = t.lastIndexOf(" ", n);
  return `${t.slice(0, i > 0 ? i : n).trimEnd()}…`;
};

const wordsOf = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Rank a search entry: an exact title first, then whole-word title matches, then prefixes. */
function score(item: SearchItem, q: string, words: string[]): number | null {
  const title = item.title.toLowerCase();
  const hay = `${title} ${item.page.toLowerCase()} ${item.text.toLowerCase()}`;
  if (!words.every((w) => hay.includes(w))) return null;
  const titleWords = wordsOf(item.title);
  let s = title === q ? 100 : 0;
  for (const w of words) {
    if (w.length < 2) continue;
    if (titleWords.includes(w)) s += 4;
    else if (titleWords.some((t) => t.startsWith(w))) s += 2;
    else if (title.includes(w)) s += 1;
  }
  return s + (item.href.includes("#") ? 0 : 1);
}

function SearchDialog({ items, onClose }: { items: SearchItem[]; onClose: () => void }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    input.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    const words = query.split(/\s+/).filter(Boolean);
    if (!words.length) return items.filter((i) => !i.href.includes("#")).slice(0, 8);
    return items
      .map((i) => {
        const s = score(i, query, words);
        return s === null ? null : { i, s };
      })
      .filter((x): x is { i: SearchItem; s: number } => !!x)
      .sort((a, b) => b.s - a.s)
      .slice(0, 12)
      .map((x) => x.i);
  }, [q, items]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const go = useCallback(
    (href: string) => {
      onClose();
      router.push(href);
    },
    [onClose, router],
  );

  // Esc closes from anywhere in the dialog; Tab stays inside it while it is open.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !box.current) return;
    const f = [...box.current.querySelectorAll<HTMLElement>("input, a[href], button")].filter((el) => !el.hasAttribute("disabled"));
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="hd-dlg-wrap" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={onKeyDown}>
      <div ref={box} className="hd-dlg" role="dialog" aria-modal="true" aria-label="Search the docs">
        <div className="hd-dlg-in">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="m10.6 10.6 3.4 3.4" />
          </svg>
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search the docs and the guide"
            aria-label="Search"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter" && hits[sel]) go(hits[sel].href);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        {hits.length ? (
          <ul ref={list}>
            {hits.map((h, n) => (
              <li key={h.href}>
                <a
                  href={h.href}
                  className={n === sel ? "on" : undefined}
                  onMouseEnter={() => setSel(n)}
                  onClick={(e) => {
                    e.preventDefault();
                    go(h.href);
                  }}
                >
                  <b>{h.title}</b>
                  <span>{h.href.includes("#") ? h.page : `${h.page} · ${clip(h.text, 96)}`}</span>
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hd-dlg-empty">Nothing found for &ldquo;{q}&rdquo;.</p>
        )}
        <div className="hd-dlg-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>Enter</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
