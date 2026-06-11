// "updated Ns ago" caption for card headers. Hooks already return
// `lastUpdatedAt`; this renders it as a relative caption that ticks
// once a second so an operator can see at a glance how fresh a panel is.

import { useEffect, useState } from "react";
import "../styles/livedata.css";

export function formatUpdatedAgo(at: number | null, now: number = Date.now()): string {
  if (at === null) return "not updated yet";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 1) return "updated just now";
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `updated ${hours}h ago`;
}

export function UpdatedAgo({ at }: { at: number | null }) {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (at === null) return;
    const id = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [at]);

  return <span className="lv-updated">{formatUpdatedAgo(at)}</span>;
}
