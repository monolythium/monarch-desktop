// Shared chrome for one wizard step: a numbered head (gold circle for the
// current step) plus a footer nav row. The body is the step's own content.
// Keeps every step visually identical so the wizard reads as one flow.

import type { ReactNode } from "react";

export function StepShell({
  n,
  title,
  sub,
  children,
  foot,
}: {
  n: number;
  title: string;
  sub: string;
  children: ReactNode;
  foot?: ReactNode;
}) {
  return (
    <div className="card setup__panel fade-in">
      <div className="setup__panel-head">
        <div className="setup__panel-num" aria-hidden>
          {`Step ${n}`}
        </div>
        <div>
          <h2 className="setup__panel-title">{title}</h2>
          <p className="setup__panel-sub">{sub}</p>
        </div>
      </div>
      {children}
      {foot ? <div className="setup__foot">{foot}</div> : null}
    </div>
  );
}
