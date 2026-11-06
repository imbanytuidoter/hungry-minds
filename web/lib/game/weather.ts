"use client";

// Weather in the dome (handoff App.dc.html loadWeather): browser geolocation if allowed,
// else IP reverse-geocode, else Kyiv; then Open-Meteo. No keys, all off-chain.

import { useEffect, useState } from "react";

export type WxKind = "clear" | "cloudy" | "rain" | "snow" | "storm" | "fog";
export type Weather = { temp: number | null; kind: WxKind; day: boolean; city: string };

export function kindOf(code: number | null): WxKind {
  if (code == null) return "clear";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "cloudy";
  return "clear";
}

export function useWeather(): Weather {
  const [wx, setWx] = useState<Weather>({ temp: null, kind: "clear", day: true, city: "" });

  useEffect(() => {
    let cancelled = false;
    const set = (p: Partial<Weather>) => !cancelled && setWx((w) => ({ ...w, ...p }));
    const get = (lat: number, lon: number) =>
      fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}&current=temperature_2m,weather_code,is_day`)
        .then((r) => r.json())
        .then((d) => {
          const c = d.current || {};
          set({ temp: c.temperature_2m ?? null, kind: kindOf(c.weather_code ?? null), day: c.is_day !== 0 });
        })
        .catch(() => {});
    const geo = (q: string) => fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client${q}${q ? "&" : "?"}localityLanguage=en`).then((r) => r.json());
    const byIP = () =>
      geo("")
        .then((g) => {
          set({ city: g.city || g.locality || g.principalSubdivision || g.countryName || "" });
          return get(g.latitude, g.longitude);
        })
        .catch(() => {
          set({ city: "Kyiv" });
          return get(50.45, 30.52);
        });

    let done = false;
    const fallback = () => {
      if (!done) {
        done = true;
        byIP();
      }
    };
    try {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          if (done) return;
          done = true;
          const { latitude: la, longitude: lo } = p.coords;
          get(la, lo);
          geo(`?latitude=${la.toFixed(2)}&longitude=${lo.toFixed(2)}`)
            .then((g) => set({ city: g.city || g.locality || g.principalSubdivision || "" }))
            .catch(() => {});
        },
        fallback,
        { timeout: 5000 }
      );
      const t = setTimeout(fallback, 5500);
      return () => {
        cancelled = true;
        clearTimeout(t);
      };
    } catch {
      fallback();
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return wx;
}
