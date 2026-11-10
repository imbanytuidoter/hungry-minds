import { Fraunces, Geist_Mono } from "next/font/google";

// The docs, the guide and the 404 wear the landing's faces. One shared instance, used by the docs
// layout and also loaded from the root layout so the 404 (which Next renders without the docs
// layout's CSS) gets them too. Not preloaded: the game pages never use these.
export const docsSerif = Fraunces({ subsets: ["latin"], variable: "--font-fraunces", axes: ["SOFT", "WONK", "opsz"], preload: false });
export const docsMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", preload: false });
