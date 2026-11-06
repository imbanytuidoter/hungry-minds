import type { Metadata } from "next";
import { DM_Serif_Display, Figtree } from "next/font/google";
import GameProvider from "@/components/game/GameProvider";
import "./game.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", weight: ["400", "500", "600", "700"] });
const serif = DM_Serif_Display({ subsets: ["latin"], variable: "--font-dm-serif", weight: "400" });

export const metadata: Metadata = {
  title: "Hungry Minds — play",
  description: "Hatch a Mind, feed it, talk to it, keep it alive.",
};

export default function GameLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`${figtree.variable} ${serif.variable}`}>
      <GameProvider>{children}</GameProvider>
    </div>
  );
}
