import type { Metadata } from "next";
import { DM_Serif_Display, Figtree, Fraunces, Geist_Mono, Space_Grotesk } from "next/font/google";
import GameProvider from "@/components/game/GameProvider";
import { MODE_BOOT } from "@/components/ModeToggle";
import "./game.css";
import "./themes.css";
import "./seed.css";

// variable Figtree (300..900): Google serves the "400;500;600;700" set with URLs next/font can't load
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" });
const serif = DM_Serif_Display({ subsets: ["latin"], variable: "--font-dm-serif", weight: "400" });
// display faces of the colour themes (game.css)
// variable faces only: Google serves some fixed weight sets with URLs next/font can't load
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const fraunces = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", style: ["normal", "italic"] });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Hungry Minds · the game",
  description: "Hatch a Mind, give her an agent, sell her services and earn from every job. Keep her fed.",
};

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${figtree.variable} ${serif.variable} ${grotesk.variable} ${fraunces.variable} ${mono.variable}`}>
      <script dangerouslySetInnerHTML={{ __html: MODE_BOOT }} />
      <GameProvider>{children}</GameProvider>
    </div>
  );
}
