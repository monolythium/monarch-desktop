// Shared charter editor — the 10-row per-seat share grid + the delegator
// slider + the live "Σ = X / 10000" sum indicator. ONE component drives
// both the cluster-FORMATION charter (Ceremony Room) and the live-cluster
// charter-AMENDMENT (Charter panel) so the editor UX, the %/sum rendering,
// and the client-side guardrails are never duplicated.
//
// The component is controlled: the parent owns the member-share strings
// and the delegator bps, and gets every keystroke back. It renders the
// floor/sum guidance and a sum/floor status pill, but enforcement of the
// guardrails (refuse-to-propose) lives with the parent via
// `validateCharterDraft` — this is presentation, not policy.

import {
  bpsToPct,
  charterSeatLabel,
  memberShareSum,
  FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS,
  FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS,
} from "../sdk/charterShare";

const inputStyle = {
  background: "rgba(0,0,0,0.3)",
  border: "1px solid rgba(255,255,255,0.1)",
  color: "var(--fg-200)",
  padding: "6px 8px",
  borderRadius: 6,
  fontSize: 12,
  width: 90,
} as const;

export function CharterEditor(props: {
  /** Ten member-share strings (bps), member-declaration order. */
  memberShareRows: string[];
  onMemberShareChange: (index: number, value: string) => void;
  delegatorShareBps: number;
  onDelegatorShareChange: (bps: number) => void;
  disabled?: boolean;
}) {
  const { memberShareRows, delegatorShareBps, disabled } = props;
  const shareSum = memberShareSum(memberShareRows);
  const sumExact = shareSum === FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS;
  const delegatorBelowFloor = delegatorShareBps < FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <span className="cap" style={{ fontSize: 10 }}>
            Per-seat shares (bps of the operator pot)
          </span>
          <span
            className={sumExact ? "halo halo--ok" : "halo halo--err"}
            style={{ fontSize: 10.5 }}
          >
            <span className="dot" />
            {Number.isNaN(shareSum) ? "invalid" : shareSum} / {FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS}
            {sumExact ? "" : " — must sum to exactly 10000"}
          </span>
        </div>
        <span style={{ fontSize: 10.5, color: "var(--fg-400)", lineHeight: 1.4 }}>
          Each seat's share of what's left AFTER delegators are paid. The ten
          shares are a split of the operator pot among themselves — they always
          add up to 10000 bps (100%), independent of the delegator share below.
        </span>
        {memberShareRows.map((value, index) => {
          const bps = Number.parseInt(value.trim(), 10);
          const pct = Number.isInteger(bps) && bps >= 0 ? bpsToPct(bps) : "—";
          return (
            <div
              key={`charter-share-${index}`}
              style={{ display: "flex", gap: 8, alignItems: "center" }}
            >
              <span className="kv__k" style={{ width: 86, flex: "0 0 auto" }}>
                {charterSeatLabel(index)}
              </span>
              <input
                className="mono"
                inputMode="numeric"
                disabled={disabled}
                value={value}
                onChange={(event) => props.onMemberShareChange(index, event.target.value)}
                style={inputStyle}
                aria-label={`${charterSeatLabel(index)} share in basis points`}
              />
              <span className="mono" style={{ fontSize: 11, color: "var(--fg-400)" }}>
                = {pct}
              </span>
            </div>
          );
        })}
      </div>

      <label className="kv" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="kv__k">
          Delegator share — {bpsToPct(delegatorShareBps)} ({delegatorShareBps} bps)
        </span>
        <input
          type="range"
          min={FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS}
          max={FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS}
          step={50}
          disabled={disabled}
          value={Math.max(delegatorShareBps, FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS)}
          onChange={(event) =>
            props.onDelegatorShareChange(Number.parseInt(event.target.value, 10))
          }
          aria-label="Delegator share in basis points"
        />
        <span
          style={{
            fontSize: 10.5,
            color: delegatorBelowFloor ? "var(--err)" : "var(--fg-400)",
          }}
        >
          The portion of every block reward that goes to the delegators who
          staked behind this cluster. Protocol floor{" "}
          {bpsToPct(FORM_CLUSTER_CHARTER_DELEGATOR_FLOOR_BPS, 0)} — a charter can
          never starve delegators below it.
        </span>
      </label>

      {/* Resulting split, in plain terms. */}
      <div
        className="halo halo--info"
        style={{ alignSelf: "flex-start", alignItems: "flex-start", lineHeight: 1.45, fontSize: 11 }}
      >
        <span className="dot" style={{ flex: "0 0 auto", marginTop: 4 }} />
        <span>
          Of every block reward this cluster earns,{" "}
          <strong>{bpsToPct(delegatorShareBps)}</strong> goes to delegators and the
          remaining <strong>{bpsToPct(FORM_CLUSTER_CHARTER_SHARE_DENOM_BPS - delegatorShareBps)}</strong>{" "}
          is the operator pot, split across the ten seats by the shares above.
        </span>
      </div>
    </div>
  );
}
