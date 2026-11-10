"use client";

import { createElement, useEffect } from "react";

/** The light/dark switch shared with the landing: the <hm-mode-toggle> element from
 *  /kit/theme-toggle.js. It flips html[data-mode] and remembers it as localStorage "hm-mode". */
export default function ModeToggle() {
  useEffect(() => {
    // where the boot script could not run first (a client-rendered 404), restore the saved mode here
    try {
      const d = document.documentElement;
      if (!d.dataset.mode && localStorage.getItem("hm-mode") === "light") d.dataset.mode = "light";
    } catch {}
    if (customElements.get("hm-mode-toggle") || document.querySelector("script[data-hm-toggle]")) return;
    const s = document.createElement("script");
    s.src = "/kit/theme-toggle.js";
    s.defer = true;
    s.dataset.hmToggle = "1";
    document.head.appendChild(s);
  }, []);
  return createElement("hm-mode-toggle", { className: "hm-mode-slot" });
}

/** Runs before the first paint (inlined in the game layout), so a saved light mode, theme and
 *  palette show at once instead of after hydration. Mirrors GameApp's useTheme. */
export const MODE_BOOT = `try{var d=document.documentElement,q=new URLSearchParams(location.search),s=localStorage;if(s.getItem("hm-mode")==="light")d.dataset.mode="light";var t=q.get("theme")||s.getItem("hm-theme")||"seed";if(["seed","garden","cosmos","jungle","desert","abyss","paper"].indexOf(t)<0)t="seed";d.dataset.theme=t;var p=q.get("p")||"ice";if(["gold","ours","plum","midnight","ice"].indexOf(p)<0)p="ice";if(p==="gold")delete d.dataset.palette;else d.dataset.palette=p}catch(e){}`;
