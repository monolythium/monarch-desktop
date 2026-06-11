// 72px persistent Ask Monarch bar. Captures the operator's free-text
// query and dispatches `monarch:ask` for the Ask view to consume.
//
// The advisory-bridge listener in `views/Ask.tsx` is now the only
// place that decides whether the operator's query results in a drawer
// action. The live bridge either parses a real `<proposed_action>` block
// out of the model's reply (and dispatches that into the drawer at
// `preview`) or returns plain advisory text. Never auto-execute.

import { useEffect, useRef, useState, type FormEvent } from "react";

const QUICK_PROMPTS = [
  { label: "why the misses?", query: "why did I miss the last 3 rounds?" },
  { label: "removal risk?", query: "am I at risk of being removed from rotation?" },
  { label: "rotate keys?", query: "is it safe to rotate my signing key now?" },
];

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

export function AskBar() {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "/" || isEditable(e.target)) return;
      e.preventDefault();
      inputRef.current?.focus();
      window.dispatchEvent(new CustomEvent("monarch:ask-open"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    // Hand off to the Ask view, which owns the advisory-bridge round trip
    // and any drawer dispatch that comes out of it.
    window.dispatchEvent(new CustomEvent("monarch:ask", { detail: trimmed }));
    setValue("");
  };

  const firePrompt = (query: string) => {
    window.dispatchEvent(new CustomEvent("monarch:ask", { detail: query }));
  };

  return (
    <footer className="monarch-askbar" role="contentinfo">
      <div className="monarch-askbar__sigil" aria-hidden />
      <form onSubmit={submit} style={{ flex: 1, display: "flex" }}>
        <input
          ref={inputRef}
          className="monarch-askbar__input"
          placeholder="Ask Monarch — every action routes through Operations drawer"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="Ask Monarch"
        />
      </form>
      <div className="monarch-askbar__quick">
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt.label}
            type="button"
            className="monarch-askbar__quick-btn"
            onClick={() => firePrompt(prompt.query)}
          >
            {prompt.label}
          </button>
        ))}
      </div>
      <div className="monarch-askbar__hint" aria-hidden>
        <kbd>/</kbd>
        <span>focus</span>
      </div>
    </footer>
  );
}
