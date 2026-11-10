import Link from "next/link";
import DocsLayout from "@/components/docs/DocsLayout";
import ModeToggle from "@/components/ModeToggle";

/** 404 in the same look as the docs and the guide. */
export default function NotFound() {
  return (
    <DocsLayout>
      <header className="hd-top">
        <Link className="hd-brand" href="/" aria-label="Hungry Minds home">
          {/* eslint-disable-next-line @next/next/no-img-element -- a vector badge */}
          <img src="/kit/brand/logo.svg" alt="" width={32} height={32} />
          <b>hungry minds</b>
        </Link>
        <nav className="hd-links" aria-label="Site">
          <Link href="/guide" className="hide-sm">
            Guide
          </Link>
          <Link href="/docs" className="hide-sm">
            Docs
          </Link>
          <Link className="hd-btn" href="/app">
            Open the game
          </Link>
          <ModeToggle />
        </nav>
      </header>
      <main className="hd-404">
        <p className="hd-crumbs">404</p>
        <h1>This page doesn&apos;t exist</h1>
        <p className="hd-lead">The link may be old, or the page has moved.</p>
        <div className="hd-cards">
          <Link className="hd-card" href="/">
            <b>Home</b>
            <span>Back to the colony.</span>
          </Link>
          <Link className="hd-card" href="/docs">
            <b>Docs</b>
            <span>Every rule, fee and contract detail.</span>
          </Link>
          <Link className="hd-card" href="/app">
            <b>Open the game</b>
            <span>Hatch a Mind or look around.</span>
          </Link>
        </div>
      </main>
    </DocsLayout>
  );
}
