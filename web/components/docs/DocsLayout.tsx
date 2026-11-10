import { MODE_BOOT } from "@/components/ModeToggle";
import { docsMono, docsSerif } from "./fonts";
import "./docs.css";

// The docs and the player guide wear the landing's look: Fraunces on dark velvet with one ice-blue
// light, and the same light/dark switch (saved as localStorage "hm-mode").
export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`hd ${docsSerif.variable} ${docsMono.variable}`}>
      <script dangerouslySetInnerHTML={{ __html: MODE_BOOT }} />
      {children}
    </div>
  );
}
