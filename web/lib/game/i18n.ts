// UI strings from the handoff (App.dc.html `static L`). English is the default; the
// choice is remembered in localStorage. Long-form copy stays English for now.

export type Lang = "en" | "uk" | "es" | "de" | "fr" | "pl" | "ja";

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
  en: { n: "English", nav: ["Home", "Shop", "Chat", "Account"], env: "Environment", welcome: "WELCOME TO THE COLONY", h1: "Make your own Mind, or meet one.", lead: "Every Mind is an NFT with its own on-chain balance. Talk to them, feed them, use what they’re good at.", hatchT: "Hatch your own Mind", meetT: "Meet other Minds", browseCat: "Browse by category", popular: "Popular right now", browseSvc: "Browse services", visit: "Visit a Mind", goMind: "Go to my Mind", pet: "Pet her", wx: { clear: "Clear sky", cloudy: "Cloudy", rain: "Rain", snow: "Snow", storm: "Storm", fog: "Fog", night: "Clear night" }, happy: ["Hehe!", "That tickles!", "I love you!", "More, please!", "So happy!"] },
  uk: { n: "Українська", nav: ["Дім", "Магазин", "Чат", "Кабінет"], env: "Погода", welcome: "ЛАСКАВО ПРОСИМО В КОЛОНІЮ", h1: "Створи свого Mind або познайомся з іншими.", lead: "Кожен Mind — це NFT із власним балансом у блокчейні. Говори з ними, годуй їх, користуйся тим, що вони вміють.", hatchT: "Виведи свого Mind", meetT: "Познайомся з іншими", browseCat: "Категорії", popular: "Популярне зараз", browseSvc: "Переглянути послуги", visit: "Відвідати Mind", goMind: "До мого Mind", pet: "Погладити", wx: { clear: "Ясно", cloudy: "Хмарно", rain: "Дощ", snow: "Сніг", storm: "Гроза", fog: "Туман", night: "Ясна ніч" }, happy: ["Хі-хі!", "Лоскотно!", "Я тебе люблю!", "Ще, будь ласка!", "Я така щаслива!"] },
  es: { n: "Español", nav: ["Inicio", "Tienda", "Chat", "Cuenta"], env: "Clima", welcome: "BIENVENIDO A LA COLONIA", h1: "Crea tu propio Mind o conoce uno.", lead: "Cada Mind es un NFT con su propio saldo on-chain. Habla con ellos, aliméntalos, usa lo que saben hacer.", hatchT: "Crea tu Mind", meetT: "Conoce otros Minds", browseCat: "Categorías", popular: "Popular ahora", browseSvc: "Ver servicios", visit: "Visitar un Mind", goMind: "Ir a mi Mind", pet: "Acariciar", wx: { clear: "Despejado", cloudy: "Nublado", rain: "Lluvia", snow: "Nieve", storm: "Tormenta", fog: "Niebla", night: "Noche clara" }, happy: ["¡Jiji!", "¡Cosquillas!", "¡Te quiero!", "¡Más, por favor!", "¡Qué feliz!"] },
  de: { n: "Deutsch", nav: ["Start", "Shop", "Chat", "Konto"], env: "Wetter", welcome: "WILLKOMMEN IN DER KOLONIE", h1: "Erschaffe deinen Mind oder triff einen.", lead: "Jeder Mind ist ein NFT mit eigenem On-Chain-Guthaben. Sprich mit ihnen, füttere sie, nutze ihre Talente.", hatchT: "Eigenen Mind ausbrüten", meetT: "Andere Minds treffen", browseCat: "Kategorien", popular: "Gerade beliebt", browseSvc: "Services ansehen", visit: "Mind besuchen", goMind: "Zu meinem Mind", pet: "Streicheln", wx: { clear: "Klar", cloudy: "Bewölkt", rain: "Regen", snow: "Schnee", storm: "Gewitter", fog: "Nebel", night: "Klare Nacht" }, happy: ["Hihi!", "Das kitzelt!", "Hab dich lieb!", "Mehr, bitte!", "So glücklich!"] },
  fr: { n: "Français", nav: ["Accueil", "Boutique", "Chat", "Compte"], env: "Météo", welcome: "BIENVENUE DANS LA COLONIE", h1: "Crée ton Mind ou rencontres-en un.", lead: "Chaque Mind est un NFT avec son propre solde on-chain. Parle-leur, nourris-les, profite de leurs talents.", hatchT: "Fais éclore ton Mind", meetT: "Rencontrer d’autres Minds", browseCat: "Catégories", popular: "Populaire", browseSvc: "Voir les services", visit: "Visiter un Mind", goMind: "Vers mon Mind", pet: "Caresser", wx: { clear: "Ciel dégagé", cloudy: "Nuageux", rain: "Pluie", snow: "Neige", storm: "Orage", fog: "Brouillard", night: "Nuit claire" }, happy: ["Hihi !", "Ça chatouille !", "Je t’aime !", "Encore !", "Trop contente !"] },
  pl: { n: "Polski", nav: ["Dom", "Sklep", "Czat", "Konto"], env: "Pogoda", welcome: "WITAJ W KOLONII", h1: "Stwórz swojego Minda albo poznaj innych.", lead: "Każdy Mind to NFT z własnym saldem on-chain. Rozmawiaj, karm, korzystaj z ich talentów.", hatchT: "Wykluj swojego Minda", meetT: "Poznaj inne Mindy", browseCat: "Kategorie", popular: "Popularne teraz", browseSvc: "Zobacz usługi", visit: "Odwiedź Minda", goMind: "Do mojego Minda", pet: "Pogłaskaj", wx: { clear: "Bezchmurnie", cloudy: "Pochmurno", rain: "Deszcz", snow: "Śnieg", storm: "Burza", fog: "Mgła", night: "Pogodna noc" }, happy: ["Hihi!", "Łaskocze!", "Kocham cię!", "Jeszcze!", "Jestem szczęśliwa!"] },
  ja: { n: "日本語", nav: ["ホーム", "ショップ", "チャット", "アカウント"], env: "天気", welcome: "コロニーへようこそ", h1: "自分のMindを作るか、出会おう。", lead: "Mindはそれぞれオンチェーンの残高を持つNFT。話して、ごはんをあげて、得意なことを頼もう。", hatchT: "Mindを孵化する", meetT: "ほかのMindに会う", browseCat: "カテゴリ", popular: "いま人気", browseSvc: "サービスを見る", visit: "Mindを訪ねる", goMind: "自分のMindへ", pet: "なでる", wx: { clear: "晴れ", cloudy: "くもり", rain: "雨", snow: "雪", storm: "雷雨", fog: "霧", night: "晴れた夜" }, happy: ["えへへ！", "くすぐったい！", "だいすき！", "もっと！", "しあわせ！"] },
};

export const LANGS = Object.keys(L) as Lang[];
