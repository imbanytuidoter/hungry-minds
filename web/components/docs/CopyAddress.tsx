"use client";

import { useState } from "react";

/** An account id or address with a copy button, as crypto docs show contract addresses. */
export default function CopyAddress({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="hd-addr">
      <code>{value}</code>
      <button
        type="button"
        aria-label={done ? "Copied" : `Copy ${value}`}
        title={done ? "Copied" : "Copy"}
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => {
              setDone(true);
              setTimeout(() => setDone(false), 1400);
            },
            () => {},
          );
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {done ? (
            <path d="m3.5 8.5 3 3 6-7" />
          ) : (
            <>
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
              <path d="M10.5 5.5V3.9c0-.9-.7-1.4-1.4-1.4H3.9c-.8 0-1.4.6-1.4 1.4v5.2c0 .8.6 1.4 1.4 1.4h1.6" />
            </>
          )}
        </svg>
      </button>
    </span>
  );
}
