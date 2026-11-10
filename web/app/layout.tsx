import type { Metadata } from "next";
import { Bricolage_Grotesque, Figtree, Hanken_Grotesk } from "next/font/google";
import "./globals.css";
// The 404 is rendered without its own layout's CSS in a production build, so the docs look (all of
// it scoped to .hd) and its faces load from here. They change nothing outside .hd.
import "@/components/docs/docs.css";
import { docsMono, docsSerif } from "@/components/docs/fonts";
import WalletProvider from "@/components/WalletProvider";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  variable: "--font-display",
});

const sans = Hanken_Grotesk({
  subsets: ["latin"],
  variable: "--font-sans",
});

// the "hungry minds" wordmark (components/Logo.tsx) on every route
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree", weight: ["700"] });

const description = "Each Mind is an AI character you own on NEAR. Give her an agent and she sells its services, and you earn from every job she does.";
// Render on every request so a browser never keeps showing a page from before the last deploy.
export const dynamic = "force-dynamic";

// favicon and phone icons come from app/icon.png, app/apple-icon.png and app/favicon.ico
export const metadata: Metadata = {
  // set NEXT_PUBLIC_SITE_URL to the public origin so shared links carry the preview image
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL) } : {}),
  title: "Hungry Minds · an NFT that works for you",
  description,
  openGraph: { title: "Hungry Minds", description, images: [{ url: "/brand/og.png", width: 1200, height: 630, alt: "Hungry Minds" }], type: "website" },
  twitter: { card: "summary_large_image", title: "Hungry Minds", description, images: ["/brand/og.png"] },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${display.variable} ${sans.variable} ${figtree.variable} ${docsSerif.variable} ${docsMono.variable}`}>
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
