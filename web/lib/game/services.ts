// Colony services. A service is a job (contract/src/agents.rs, `order_job`): the price waits
// in escrow until delivery, then 90% to the Mind's owner / 10% protocol. In the demo world
// it is played as a paid chat.

export type Category = "predict" | "whales" | "data" | "yield" | "defi" | "risk" | "research" | "content" | "companion" | "agents" | "dev";

/** Contract category index order (colony.rs CATEGORIES): the 11 service categories. */
export const CAT_IDS: Category[] = ["predict", "whales", "data", "yield", "defi", "risk", "research", "content", "companion", "agents", "dev"];

/** Categories that sell facts: only a real agent may deliver them (contract: needs_agent). */
export const needsAgent = (c: Category) => CAT_IDS.indexOf(c) < 7;

/** A published service as the UI sees it, from the chain or the demo world. */
export type Offer = {
  id: number;
  mindId: number;
  title: string;
  desc: string;
  cat: Category;
  price: number;
  unit: string;
  live: boolean;
  orders: number;
  fed: number; // NEAR this service has paid the Mind's owner (their 90%)
  badge?: "Bestseller" | "New";
  rating?: number;
  sla?: string;
  /** Live: the service's input form (a JSON Schema object), if it has one. */
  schema?: import("@/lib/agentClient").InputSchema | null;
  /** Live: a request to start with (from the Navigator). */
  prefill?: string;
};

export type Service = {
  cat: Category;
  title: string;
  desc: string;
  price: number;
  unit: string;
  sla: string;
  orders: number;
  rating: number;
  badge?: "Bestseller" | "New";
  fresh: number; // higher = newer
  mind: string; // name of a colony Mind (lib/game/world.ts SEED)
};

export const CATEGORIES: { id: Category | "all"; name: string; hint: string; icon: string; tile: string; ink: string; glossy: [string, string, string] }[] = [
  { id: "all", name: "All", hint: "Every live service", icon: "M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.2 2.2M15.3 15.3l2.2 2.2M17.5 6.5l-2.2 2.2M8.7 15.3l-2.2 2.2", tile: "#FFE3EE", ink: "#E0558F", glossy: ["#FFD0E3", "#FF85B5", "#E2508E"] },
  { id: "predict", name: "Prediction markets", hint: "Odds, hot markets and the wallets that win", icon: "M4 19h16M6 16l4-5 3 3 5-7M18 7h-3M18 7v3", tile: "#E8E4FF", ink: "#5B4BC4", glossy: ["#E6E1FF", "#A79BFF", "#6A58E0"] },
  { id: "whales", name: "Whales & wallets", hint: "Who holds what, and what big wallets do", icon: "M3 13c2-3 5-4 8-4 4 0 7 2 9 5-2 2-5 3-9 3-4 0-6-1-8-4zM16 12h.01M3 13l-1-4 3 2", tile: "#DFF1FF", ink: "#2C7BC0", glossy: ["#DCF0FF", "#82C4FF", "#3A8FE0"] },
  { id: "data", name: "Market data", hint: "Prices and on-chain numbers, pay per call", icon: "M4 20V10M10 20V4M16 20v-7M22 20H2", tile: "#E3ECFF", ink: "#3F6AD8", glossy: ["#DDE8FF", "#8FB0FF", "#4E74D6"] },
  { id: "yield", name: "Yield", hint: "Where your tokens earn the most", icon: "M12 3v18M7 8c0-2 2-3 5-3s5 1 5 3-2 3-5 3-5 1-5 3 2 3 5 3 5-1 5-3", tile: "#DDF5E6", ink: "#1F9A5A", glossy: ["#D8FBE8", "#7FE0AE", "#3FB97C"] },
  { id: "defi", name: "DeFi & swaps", hint: "Quotes and actions across chains", icon: "M4 8h13l-3-3M20 16H7l3 3", tile: "#E1F7F4", ink: "#178A7B", glossy: ["#D9F7F2", "#79DCCB", "#2FAF9C"] },
  { id: "risk", name: "Risk alerts", hint: "Liquidation, depeg and position health", icon: "M12 3l9 16H3zM12 10v4M12 17h.01", tile: "#FFEBDD", ink: "#C4612A", glossy: ["#FFE5D3", "#FFAD7A", "#E8774A"] },
  { id: "research", name: "Research & due diligence", hint: "Token checks, contracts and sourced answers", icon: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L21 21", tile: "#EFE6FA", ink: "#7A55C8", glossy: ["#EEE4FF", "#B79CFF", "#8565E0"] },
  { id: "content", name: "Content & marketing", hint: "Posts, ads, stories and translation", icon: "M14.5 4.5l5 5L9 20H4v-5zM12.5 6.5l5 5", tile: "#FFE6D3", ink: "#D9702A", glossy: ["#FFE2D1", "#FFA77A", "#E8774A"] },
  { id: "companion", name: "Companions", hint: "Talk, play and keep company", icon: "M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5zM9 10h.01M12 10h.01M15 10h.01", tile: "#FFE3EE", ink: "#D9437F", glossy: ["#FFD0E3", "#FF85B5", "#E2508E"] },
  { id: "agents", name: "For agents", hint: "Checks, routing and trust for other agents", icon: "M9 3h6M12 3v3M6.5 6h11A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8A2.5 2.5 0 0 1 6.5 6zM9 12h.01M15 12h.01M9.5 15.5h5", tile: "#E3EEFF", ink: "#3D5BA9", glossy: ["#DDE8FF", "#8FB0FF", "#4E74D6"] },
  { id: "dev", name: "Build & deploy", hint: "Code, sites and deployments", icon: "M8 8l-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14", tile: "#F1EEE8", ink: "#6E5F48", glossy: ["#F2EEE6", "#CDBF9F", "#9E8A63"] },
];

export const CAT_TINT: Record<Category, string> = {
  predict: "#E8E4FF",
  whales: "#DFF1FF",
  data: "#E3ECFF",
  yield: "#DDF5E6",
  defi: "#E1F7F4",
  risk: "#FFEBDD",
  research: "#EFE6FA",
  content: "#FFE6D3",
  companion: "#FFE3EE",
  agents: "#E3EEFF",
  dev: "#F1EEE8",
};

export const SERVICES: Service[] = [
  { cat: "content", title: "Bedtime story", desc: "A new 3-minute story every night, starring you and her.", price: 0.05, unit: "story", sla: "< 1 min", orders: 1713, rating: 4.9, badge: "Bestseller", fresh: 2, mind: "Nova" },
  { cat: "companion", title: "Morning check-in", desc: "She asks how you slept and remembers your answer tomorrow.", price: 0.02, unit: "call", sla: "< 1 min", orders: 1598, rating: 4.8, fresh: 3, mind: "Pip" },
  { cat: "research", title: "Ukrainian in 5 words", desc: "Five new words a day, quizzed the next morning.", price: 0.03, unit: "lesson", sla: "< 2 min", orders: 1237, rating: 4.9, fresh: 5, mind: "Moss" },
  { cat: "companion", title: "Riddle duel", desc: "She asks a riddle, you get three guesses. Loser feeds the winner.", price: 0.01, unit: "riddle", sla: "instant", orders: 1203, rating: 4.7, fresh: 4, mind: "Wren" },
  { cat: "content", title: "Tiny poem", desc: "A four-line poem about anything you send her.", price: 0.04, unit: "poem", sla: "< 1 min", orders: 1103, rating: 4.8, fresh: 6, mind: "Nova" },
  { cat: "companion", title: "Calm breathing", desc: "A guided 2-minute breathing session in her soft voice.", price: 0.02, unit: "session", sla: "instant", orders: 1040, rating: 4.9, fresh: 7, mind: "Ash" },
  { cat: "companion", title: "Pep talk", desc: "Before an exam or interview, she hypes you up.", price: 0.02, unit: "call", sla: "instant", orders: 895, rating: 4.8, fresh: 8, mind: "Kiko" },
  { cat: "content", title: "Choose your path", desc: "A branching adventure, one chapter per message.", price: 0.06, unit: "chapter", sla: "< 1 min", orders: 630, rating: 4.7, badge: "New", fresh: 11, mind: "Juno" },
  { cat: "research", title: "Star facts", desc: "One true story about a star or planet you pick.", price: 0.03, unit: "fact", sla: "< 1 min", orders: 581, rating: 4.6, fresh: 9, mind: "Sol" },
  { cat: "companion", title: "20 questions", desc: "She thinks of something, you have 20 questions.", price: 0.02, unit: "game", sla: "instant", orders: 529, rating: 4.7, fresh: 10, mind: "Tilly" },
  { cat: "content", title: "Name generator", desc: "Ten names for a pet, a project or a band.", price: 0.01, unit: "list", sla: "instant", orders: 407, rating: 4.5, fresh: 12, mind: "Moss" },
  { cat: "companion", title: "Gratitude journal", desc: "She asks for three good things and keeps them for you.", price: 0.02, unit: "entry", sla: "< 1 min", orders: 383, rating: 4.9, badge: "New", fresh: 13, mind: "Pip" },
];
