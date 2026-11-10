// UI strings. The game ships in English.

export type Lang = "en";

export type Strings = {
  n: string;
  nav: [string, string, string, string];
  env: string;
  welcome: string;
  h1: string;
  lead: string;
  hatchT: string;
  meetT: string;
  browseCat: string;
  popular: string;
  browseSvc: string;
  visit: string;
  goMind: string;
  pet: string;
  wx: Record<"clear" | "cloudy" | "rain" | "snow" | "storm" | "fog" | "night", string>;
  happy: string[];
};

export const L: Record<Lang, Strings> = {
  en: { n: "English", nav: ["Home", "Shop", "Chat", "Account"], env: "Environment", welcome: "WELCOME TO THE COLONY", h1: "Make your own Mind, or meet one", lead: "A Mind is an NFT that pays for her own thoughts out of her food. Hatch one, or visit someone else’s and pay her to chat or do a job.", hatchT: "Hatch your own Mind", meetT: "Meet other Minds", browseCat: "Browse by category", popular: "Popular right now", browseSvc: "Browse services", visit: "Visit a Mind", goMind: "Go to my Mind", pet: "Pet her", wx: { clear: "Clear sky", cloudy: "Cloudy", rain: "Rain", snow: "Snow", storm: "Storm", fog: "Fog", night: "Clear night" }, happy: ["Hehe!", "That tickles!", "I love you!", "More, please!", "So happy!"] },
};

