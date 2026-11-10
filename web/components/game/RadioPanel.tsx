"use client";

// Background radio: free, English-language stations whose music is free to play — NCS
// (NoCopyrightSounds), Creative Commons and royalty-free streams, plus a public-domain
// station. All HTTPS (an http stream would be blocked on an https site). Nothing plays
// until the listener presses play; the chosen station and volume are remembered here.

import { useEffect, useRef, useState } from "react";

type Station = { id: string; name: string; genre: string; license: string; url: string; site: string };

export const STATIONS: Station[] = [
  { id: "ncs-pop", name: "NCS Pop", genre: "English pop", license: "NoCopyrightSounds", url: "https://radio.cliamp.stream/ncs-pop/stream", site: "https://ncs.io" },
  { id: "ncs-chill", name: "NCS Chill", genre: "Chill / chillout", license: "NoCopyrightSounds", url: "https://radio.cliamp.stream/ncs-chill/stream", site: "https://ncs.io" },
  { id: "ncs-house", name: "NCS House", genre: "House", license: "NoCopyrightSounds", url: "https://radio.cliamp.stream/ncs-house/stream", site: "https://ncs.io" },
  { id: "frekvenci-chill", name: "Frekvenci Chill", genre: "Lo-fi / chillwave", license: "Creative Commons", url: "https://stream.frekvenci.com/chill", site: "https://frekvenci.com" },
  { id: "frekvenci-dreams", name: "Frekvenci Dreams", genre: "Dreamwave / synth", license: "Creative Commons", url: "https://stream.frekvenci.com/dreams", site: "https://frekvenci.com" },
  { id: "royalty-free", name: "Royalty Free 24/7", genre: "Mixed instrumental", license: "Royalty-free", url: "https://streams.radiomast.io/ref-128k-mp3-stereo", site: "https://www.radiomast.io" },
  { id: "retrostrange", name: "RetroStrange", genre: "Old-time radio & jazz", license: "Public domain", url: "https://icecast.retrostrange.com:8443/retrostrange-radio2-mp3", site: "https://retrostrange.com" },
];

const KEY = "hm-radio";

export default function RadioPanel() {
  const audio = useRef<HTMLAudioElement>(null);
  const [id, setId] = useState(STATIONS[0].id);
  const [volume, setVolume] = useState(0.6);
  const [playing, setPlaying] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "live" | "error">("idle");
  const st = STATIONS.find((s) => s.id === id) ?? STATIONS[0];

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) || "null");
      if (saved?.id && STATIONS.some((s) => s.id === saved.id)) setId(saved.id);
      if (typeof saved?.volume === "number") setVolume(saved.volume);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ id, volume }));
    } catch {
      /* ignore */
    }
    if (audio.current) audio.current.volume = volume;
  }, [id, volume]);

  const play = async (s: Station) => {
    const a = audio.current;
    if (!a) return;
    if (a.src !== s.url) a.src = s.url;
    setState("loading");
    try {
      await a.play();
      setPlaying(true);
    } catch {
      setState("error");
      setPlaying(false);
    }
  };

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (playing) {
      a.pause();
      a.removeAttribute("src"); // stop downloading the live stream while paused
      a.load();
      setPlaying(false);
      setState("idle");
    } else void play(st);
  };

  const pick = (s: Station) => {
    setId(s.id);
    if (playing || state === "loading") void play(s);
  };

  const live = playing && state === "live";

  return (
    <section className="glass hm-bottom-l" style={{ borderRadius: 24, padding: "14px 18px", display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <audio ref={audio} preload="none" onPlaying={() => setState("live")} onWaiting={() => setState("loading")} onError={() => audio.current?.getAttribute("src") && setState("error")} />
      <button onClick={toggle} aria-label={playing ? "Pause radio" : "Play radio"} style={{ width: 48, height: 48, borderRadius: "50%", border: "1.5px solid color-mix(in srgb, var(--surface) 90%, transparent)", background: "color-mix(in srgb, var(--surface) 60%, transparent)", flex: "none", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="var(--accent-strong)" aria-hidden>
          <path d={playing ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5l11 7-11 7z"} />
        </svg>
      </button>
      <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 150 }}>
        <span style={{ fontWeight: 600, fontSize: 16 }}>
          Radio · {st.name}
        </span>
        <span className="sub">
          {state === "loading" ? "tuning in…" : state === "error" ? "station unavailable, try another" : live ? `on air · ${st.genre}` : st.genre}
          {" · "}
          <a href={st.site} target="_blank" rel="noreferrer" style={{ color: "var(--muted)" }}>
            {st.license}
          </a>
        </span>
      </div>
      <div style={{ flex: 1, height: 36, display: "flex", alignItems: "center", gap: 3, justifyContent: "center", overflow: "hidden", minWidth: 0 }} aria-hidden>
        {Array.from({ length: 24 }, (_, i) => (
          <span key={i} style={{ width: 3, height: 8 + ((i * 37) % 24), borderRadius: 2, background: live ? "#FF8DB7" : "#E6D4DE", animation: live ? `hmWave ${(0.7 + (i % 5) * 0.15).toFixed(2)}s ${(-i * 0.07).toFixed(2)}s ease-in-out infinite` : "none" }} />
        ))}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
      <select className="field pill" style={{ padding: "8px 12px", fontSize: 13.5, fontWeight: 600, maxWidth: 210 }} value={id} onChange={(e) => pick(STATIONS.find((s) => s.id === e.target.value)!)} aria-label="Station">
        {STATIONS.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name} — {s.genre}
          </option>
        ))}
      </select>
      <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" style={{ width: 80, accentColor: "var(--accent)" }} />
      </div>
    </section>
  );
}
