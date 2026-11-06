import { Figtree } from "next/font/google";
import Landing from "@/components/landing/Landing";
import "./landing.css";

const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", weight: ["400", "500", "600", "700"] });

// The landing page (design handoff Landing.dc.html). The game is at /app.
export default function Home() {
  return (
    <div className={figtree.variable}>
      <Landing />
    </div>
  );
}
