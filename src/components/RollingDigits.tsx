// Rolling-digit ticker for the Home hero block height. Each digit is a
// vertical 0-9 reel that rolls to the new value when the WS feed pushes
// a commit; group separators stay static. Reduced motion snaps the reel
// (no transition). Font size/face inherit from the wrapping hero number.

import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import "../styles/ticker.css";

const REEL_DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

function Reel({ digit, reduced }: { digit: number; reduced: boolean }) {
  return (
    <span className="hero-ticker__digit" aria-hidden="true">
      <span
        className="hero-ticker__reel"
        data-reduced={reduced ? "true" : "false"}
        style={{ transform: `translateY(-${digit}em)` }}
      >
        {REEL_DIGITS.map((d) => (
          <span key={d} className="hero-ticker__cell">
            {d}
          </span>
        ))}
      </span>
    </span>
  );
}

export function RollingDigits({
  value,
  suffix,
}: {
  /** The number to display; null renders an em-dash. */
  value: number | null;
  suffix?: string;
}) {
  const reduced = usePrefersReducedMotion();

  if (value === null || !Number.isFinite(value)) {
    return <span className="hero-ticker">—</span>;
  }

  const text = Math.trunc(value).toLocaleString("en-US");
  const chars = text.split("");

  return (
    <span className="hero-ticker" data-reduced={reduced ? "true" : "false"} aria-label={text}>
      <span className="hero-ticker__num">
        {chars.map((ch, i) => {
          // Key digits by their distance from the LEAST significant
          // position so existing reels keep rolling in place when the
          // number gains a digit on the left.
          const key = `c${chars.length - i}`;
          return /\d/.test(ch) ? (
            <Reel key={key} digit={Number(ch)} reduced={reduced} />
          ) : (
            <span key={key} className="hero-ticker__sep" aria-hidden="true">
              {ch}
            </span>
          );
        })}
      </span>
      {suffix ? <span className="hero-ticker__suffix">{suffix}</span> : null}
    </span>
  );
}
