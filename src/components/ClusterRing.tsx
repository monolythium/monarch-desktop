// Cluster avatar ring. Live members render around the circle; the center
// copy can still show the whitepaper target when the live roster is missing.
// Pure SVG, no animation library.

type MemberState = "nominal" | "lag" | "maintenance" | "jail";

type Member = {
  id: number;
  handle: string;
  state: MemberState;
};

const STATE_COLOR: Record<MemberState, string> = {
  nominal: "var(--ok)",
  lag: "var(--warn)",
  maintenance: "var(--info)",
  jail: "var(--err)",
};

function initials(handle: string): string {
  return handle
    .split(/[-_]/)
    .map((p) => p[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function ClusterRing({
  members,
  threshold,
  expectedSize,
  expectedThreshold,
  size = 220,
}: {
  members: Member[];
  threshold: number;
  expectedSize?: number;
  expectedThreshold?: number;
  size?: number;
}) {
  const r = size / 2 - 18;
  const cx = size / 2;
  const cy = size / 2;
  const live = members.filter((m) => m.state !== "jail").length;
  const circumference = 2 * Math.PI * (r - 14);
  const quorumRatio = members.length > 0 ? Math.min(Math.max(threshold / members.length, 0), 1) : 0;
  const quorumArc = quorumRatio * circumference;
  const displaySize = members.length > 0 ? members.length : (expectedSize ?? members.length);
  const displayThreshold = threshold > 0 ? threshold : (expectedThreshold ?? threshold);

  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-label="Cluster avatar ring">
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke="var(--glass-stroke)"
          strokeWidth={1}
        />
        <circle
          cx={cx}
          cy={cy}
          r={r - 14}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={8}
          strokeLinecap="round"
        />
        <circle
          cx={cx}
          cy={cy}
          r={r - 14}
          fill="none"
          stroke="var(--gold)"
          strokeWidth={8}
          strokeLinecap="round"
          strokeDasharray={`${quorumArc} ${circumference}`}
          transform={`rotate(-90 ${cx} ${cy})`}
          opacity={0.85}
        />
        {members.map((m, i) => {
          const angle = (i / members.length) * 2 * Math.PI - Math.PI / 2;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          const color = STATE_COLOR[m.state];
          return (
            <g key={m.id}>
              <circle cx={x} cy={y} r={16} fill={color} opacity={0.12} />
              <circle cx={x} cy={y} r={13} fill="rgba(8,8,16,0.92)" stroke={color} strokeWidth={1.4} />
              <text
                x={x}
                y={y + 3}
                textAnchor="middle"
                fontFamily="var(--f-mono)"
                fontSize={8}
                fill="var(--fg-100)"
                opacity={m.state === "jail" ? 0.45 : 1}
              >
                {initials(m.handle)}
              </text>
              {i === 0 ? (
                <g>
                  <circle cx={x + 11} cy={y - 12} r={4} fill="var(--gold)" />
                  <text
                    x={x + 20}
                    y={y - 9}
                    fontFamily="var(--f-mono)"
                    fontSize={7}
                    fill="var(--gold)"
                  >
                    YOU
                  </text>
                </g>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="ring-center">
        <div className="numeral numeral--lg">{live}</div>
        <div className="cap" style={{ marginTop: 2 }}>
          {live}/{displaySize} signing
        </div>
        <div
          className="mono"
          style={{ fontSize: 10, color: "var(--fg-500)", marginTop: 4 }}
        >
          {displayThreshold}-of-{displaySize} threshold
        </div>
      </div>
    </div>
  );
}

export type { Member, MemberState };
