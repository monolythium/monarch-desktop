import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";

export type Tweaks = {
  bleed: number;
  hueA: number;
  hueB: number;
  glassBlur: number;
  numeralScale: number;
  goldAccent: boolean;
  grain: boolean;
};

const DEFAULT_TWEAKS: Tweaks = {
  bleed: 0.55,
  hueA: 312,
  hueB: 268,
  glassBlur: 28,
  numeralScale: 1,
  goldAccent: true,
  grain: true,
};

function readTweaks(): Tweaks {
  const el = document.getElementById("monarch-tweaks");
  if (!el?.textContent) return DEFAULT_TWEAKS;
  try {
    return { ...DEFAULT_TWEAKS, ...JSON.parse(el.textContent) };
  } catch {
    return DEFAULT_TWEAKS;
  }
}

function writeTweaks(tweaks: Tweaks) {
  let el = document.getElementById("monarch-tweaks");
  if (!el) {
    el = document.createElement("script");
    el.id = "monarch-tweaks";
    el.setAttribute("type", "application/json");
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(tweaks, null, 2);
}

function applyTweaks(tweaks: Tweaks) {
  const root = document.documentElement;
  root.style.setProperty("--bleed", String(tweaks.bleed));
  root.style.setProperty("--hue-a", String(tweaks.hueA));
  root.style.setProperty("--hue-b", String(tweaks.hueB));
  root.style.setProperty("--glass-blur", `${tweaks.glassBlur}px`);
  root.style.setProperty("--numeral-scale", String(tweaks.numeralScale));
  root.classList.toggle("tweak-grain", tweaks.grain);
  root.classList.toggle("tweak-muted-gold", !tweaks.goldAccent);
}

export function useTweaks() {
  const initial = useMemo(readTweaks, []);
  const [tweaks, setTweaks] = useState<Tweaks>(initial);

  useEffect(() => {
    applyTweaks(tweaks);
    writeTweaks(tweaks);
  }, [tweaks]);

  return [tweaks, setTweaks] as const;
}

export function TweaksPanel({
  open,
  tweaks,
  setTweaks,
  onClose,
}: {
  open: boolean;
  tweaks: Tweaks;
  setTweaks: Dispatch<SetStateAction<Tweaks>>;
  onClose: () => void;
}) {
  const set = <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <aside className={open ? "tweaks is-open" : "tweaks"} aria-label="Tweaks">
      <header className="tweaks__head">
        <div>
          <div className="cap">design tokens</div>
          <h2>Tweaks</h2>
        </div>
        <button type="button" className="drawer__close" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="tweaks__body">
        <Range
          label="Gradient intensity"
          min={0}
          max={1}
          step={0.05}
          value={tweaks.bleed}
          onChange={(v) => set("bleed", v)}
        />
        <Range
          label="Hue magenta end"
          min={280}
          max={340}
          step={1}
          value={tweaks.hueA}
          onChange={(v) => set("hueA", v)}
        />
        <Range
          label="Hue violet end"
          min={240}
          max={300}
          step={1}
          value={tweaks.hueB}
          onChange={(v) => set("hueB", v)}
        />
        <Range
          label="Glass blur"
          min={12}
          max={40}
          step={1}
          value={tweaks.glassBlur}
          onChange={(v) => set("glassBlur", v)}
          unit="px"
        />
        <Range
          label="Numeral scale"
          min={0.82}
          max={1.18}
          step={0.01}
          value={tweaks.numeralScale}
          onChange={(v) => set("numeralScale", v)}
        />
        <Toggle
          label="Gold accent"
          checked={tweaks.goldAccent}
          onChange={(v) => set("goldAccent", v)}
        />
        <Toggle
          label="Grain overlay"
          checked={tweaks.grain}
          onChange={(v) => set("grain", v)}
        />
      </div>
    </aside>
  );
}

function Range({
  label,
  min,
  max,
  step,
  value,
  unit = "",
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="tweaks__control">
      <span>
        {label}
        <b className="mono">{value.toFixed(step < 1 ? 2 : 0)}{unit}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="tweaks__toggle">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}
