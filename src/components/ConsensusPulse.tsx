// CONSENSUS PULSE — live round strip. The last ~60 rounds scroll across
// a horizontal track, one column per round, each carrying a
// cluster × member dot matrix:
//
//   - gold-halo dot   = operator index present in the round certificate's
//                       signer set (lyth_getRoundCertificate, fetched per
//                       committed round, mapped across the cluster roster
//                       in directory order)
//   - dim dot         = roster seat absent from the signer set
//   - gold cluster box = that seat authored a DAG vertex this round
//                       (`dagVertices` push / lyth_verticesAtRound)
//
// Driven by the shared WS feed (`newCommit` + `dagVertices`); when push
// is unavailable it falls back to polling the round counter through the
// shared query cache. Clicking a round opens a glass popover with the
// certificate digest (4-char groups + copy), signer info, and an
// on-demand leader-certificate lookup.
//
// HONESTY RAIL: `lyth_getRoundCertificate` can return null on this chain
// (round-certificate persistence gap). The popover then says so plainly
// and falls back to vertex-author evidence — it never invents a signer set.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { rpc } from "../sdk/client";
import { useQuery } from "../sdk/queryCache";
import { liveFeed, useLiveFeedStatus } from "../sdk/subscriptions";
import { useClusterDirectory } from "../sdk";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import { UpdatedAgo } from "./UpdatedAgo";
import "../styles/livedata.css";

const MAX_ROUNDS = 60;
const BACKFILL_ROUNDS = 16;

type CertState =
  | { status: "pending" }
  | {
      status: "ok";
      digest: string;
      bitmap: string | null;
      signers: number[];
      signerCount: number;
    }
  | { status: "absent" }
  | { status: "unsupported" }
  | { status: "error"; message: string };

type PulseRound = {
  round: number;
  height: number | null;
  commitHash: string | null;
  /** author seat index -> vertex hash */
  authors: Map<number, string>;
  cert: CertState;
};

type ClusterLane = {
  clusterId: number;
  size: number;
  threshold: number;
  /** First global operator index of this cluster's roster segment. */
  offset: number;
};

function isMethodNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === -32601) return true;
  const msg = (e.message ?? "").toLowerCase();
  return msg.includes("method not found") || msg.includes("not yet exposed");
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found");
}

/** Group a hex digest into 4-char clusters for legibility. */
export function groupHex(value: string): string {
  const body = value.startsWith("0x") || value.startsWith("0X") ? value.slice(2) : value;
  return body.replace(/(.{4})/g, "$1 ").trim();
}

async function fetchCertState(round: number): Promise<CertState> {
  try {
    const cert = (await rpc.lythGetRoundCertificate(round)) as {
      signature?: unknown;
      signers_bitmap?: unknown;
      signer_indices?: unknown;
      signer_count?: unknown;
    } | null;
    if (cert === null) return { status: "absent" };
    const signers = Array.isArray(cert.signer_indices)
      ? cert.signer_indices.filter((v): v is number => typeof v === "number")
      : [];
    return {
      status: "ok",
      digest: typeof cert.signature === "string" ? cert.signature : "",
      bitmap: typeof cert.signers_bitmap === "string" ? cert.signers_bitmap : null,
      signers,
      signerCount: typeof cert.signer_count === "number" ? cert.signer_count : signers.length,
    };
  } catch (err) {
    if (isMethodNotFound(err)) return { status: "unsupported" };
    if (isNotFound(err)) return { status: "absent" };
    return { status: "error", message: (err as Error)?.message ?? String(err) };
  }
}

function CopyBtn({ text, label = "copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={copied ? "pulse__copy is-copied" : "pulse__copy"}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1400);
        });
      }}
    >
      {copied ? "copied ✓" : label}
    </button>
  );
}

export function ConsensusPulse() {
  const feed = useLiveFeedStatus();
  const reducedMotion = usePrefersReducedMotion();
  const directory = useClusterDirectory(0, 100);

  const roundsRef = useRef<Map<number, PulseRound>>(new Map());
  const certInFlight = useRef<Set<number>>(new Set());
  const verticesFetched = useRef<Set<number>>(new Set());
  const backfilled = useRef(false);
  const followRef = useRef(true);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [version, setVersion] = useState(0);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const ensureEntry = useCallback((round: number): PulseRound => {
    let entry = roundsRef.current.get(round);
    if (!entry) {
      entry = { round, height: null, commitHash: null, authors: new Map(), cert: { status: "pending" } };
      roundsRef.current.set(round, entry);
      // Trim the buffer to the newest MAX_ROUNDS entries.
      if (roundsRef.current.size > MAX_ROUNDS + 16) {
        const sorted = [...roundsRef.current.keys()].sort((a, b) => a - b);
        for (const old of sorted.slice(0, sorted.length - MAX_ROUNDS)) {
          roundsRef.current.delete(old);
        }
      }
    }
    return entry;
  }, []);

  const loadCert = useCallback(
    (round: number) => {
      if (certInFlight.current.has(round)) return;
      certInFlight.current.add(round);
      void fetchCertState(round).then((cert) => {
        certInFlight.current.delete(round);
        const entry = roundsRef.current.get(round);
        if (!entry) return;
        entry.cert = cert;
        bump();
      });
    },
    [bump],
  );

  const loadVertices = useCallback(
    async (round: number) => {
      if (verticesFetched.current.has(round)) return;
      verticesFetched.current.add(round);
      try {
        const res = await rpc.lythVerticesAtRound(round);
        const entry = roundsRef.current.get(round);
        if (!entry) return;
        for (const v of res.vertices ?? []) {
          if (typeof v.author === "number" && typeof v.vertexHash === "string") {
            entry.authors.set(v.author, v.vertexHash);
          }
        }
        bump();
      } catch {
        // Vertex history not available for this round — leave authors empty.
      }
    },
    [bump],
  );

  // WS: commits append rounds; vertices light up the authoring seat.
  useEffect(() => {
    const offCommit = liveFeed.subscribe("newCommit", (ev) => {
      if (ev.round === null) return;
      const entry = ensureEntry(ev.round);
      entry.height = ev.height;
      entry.commitHash = ev.commitHash;
      setLastEventAt(ev.at);
      loadCert(ev.round);
      // One-time backfill of the trailing window behind the first live commit.
      if (!backfilled.current) {
        backfilled.current = true;
        void (async () => {
          for (let r = ev.round! - 1; r >= Math.max(0, ev.round! - BACKFILL_ROUNDS); r -= 1) {
            ensureEntry(r);
            await loadVertices(r);
            loadCert(r);
          }
          bump();
        })();
      }
      bump();
    });
    const offVertex = liveFeed.subscribe("dagVertices", (ev) => {
      const entry = ensureEntry(ev.round);
      entry.authors.set(ev.author, ev.vertexHash);
      if (entry.height === null) entry.height = ev.height;
      setLastEventAt(ev.at);
      bump();
    });
    return () => {
      offCommit();
      offVertex();
    };
  }, [ensureEntry, loadCert, loadVertices, bump]);

  // Polling fallback when push is unavailable: the round counter comes
  // from the signing-activity surface (authority 0 always exists on a
  // producing committee); each newly seen round is hydrated over HTTP.
  const fallbackEnabled = !feed.live;
  const roundSignal = useQuery(
    fallbackEnabled ? "pulse:roundSignal" : null,
    () => rpc.lythSigningActivity(0, 1),
    { intervalMs: 5000, notExposedWhen: (err) => isMethodNotFound(err) || isNotFound(err) },
  );
  const fallbackRound = roundSignal.data ? Number(roundSignal.data.currentRound) : null;

  useEffect(() => {
    if (!fallbackEnabled || fallbackRound === null || !Number.isFinite(fallbackRound)) return;
    const known = [...roundsRef.current.keys()];
    const newest = known.length > 0 ? Math.max(...known) : fallbackRound - BACKFILL_ROUNDS;
    const from = Math.max(0, Math.max(newest + 1, fallbackRound - BACKFILL_ROUNDS));
    let cancelled = false;
    void (async () => {
      for (let r = from; r <= fallbackRound && !cancelled; r += 1) {
        ensureEntry(r);
        await loadVertices(r);
        loadCert(r);
      }
      if (!cancelled) {
        setLastEventAt(Date.now());
        bump();
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fallbackEnabled, fallbackRound, ensureEntry, loadVertices, loadCert, bump]);

  // Auto-scroll: follow the newest round unless the operator scrolled
  // back. Reduced motion snaps instead of animating.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !followRef.current) return;
    strip.scrollTo({ left: strip.scrollWidth, behavior: reducedMotion ? "auto" : "smooth" });
  }, [version, reducedMotion]);

  const onStripScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    followRef.current = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 48;
  }, []);

  const rounds = useMemo(() => {
    void version;
    return [...roundsRef.current.values()].sort((a, b) => a.round - b.round).slice(-MAX_ROUNDS);
  }, [version]);

  const lanes = useMemo<ClusterLane[]>(() => {
    const rows = [...(directory.data ?? [])].sort((a, b) => a.clusterId - b.clusterId).slice(0, 4);
    let offset = 0;
    return rows.map((row) => {
      const lane = { clusterId: row.clusterId, size: row.size, threshold: row.threshold, offset };
      offset += row.size;
      return lane;
    });
  }, [directory.data]);

  const thresholdAnnotation = useMemo(() => {
    if (lanes.length === 0) return "roster unavailable";
    const shapes = [...new Set(lanes.map((l) => `${l.threshold}-of-${l.size}`))];
    return `quorum ${shapes.join(" · ")} · ${lanes.length} cluster${lanes.length === 1 ? "" : "s"}`;
  }, [lanes]);

  const latestRound = rounds.length > 0 ? rounds[rounds.length - 1]!.round : null;
  const selected = selectedRound !== null ? roundsRef.current.get(selectedRound) ?? null : null;

  const feedHalo = feed.live
    ? { cls: "halo halo--ok", label: "live" }
    : roundSignal.data
      ? { cls: "halo halo--warn", label: "updating" }
      : feed.state === "connecting"
        ? { cls: "halo halo--info", label: "connecting" }
        : { cls: "halo halo--warn", label: "waiting" };

  return (
    <div className="card card--padded pulse" aria-label="Consensus activity">
      <div className="pulse__head">
        <div>
          <h3>Consensus activity</h3>
          <div className="sub">
            {rounds.length > 0
              ? `${rounds.length} recent rounds observed`
              : "waiting for recent rounds"}
          </div>
        </div>
        <div className="pulse__head-meta">
          <span className="pulse__threshold">{thresholdAnnotation}</span>
          <span className={feedHalo.cls}>
            <span className="dot" /> {feedHalo.label}
          </span>
          <UpdatedAgo at={lastEventAt} />
        </div>
      </div>

      {rounds.length === 0 ? (
        <div className="pulse__empty">
          Waiting for recent rounds from the connected node.
        </div>
      ) : (
        <div className="pulse__strip" ref={stripRef} onScroll={onStripScroll}>
          {rounds.map((entry) => (
            <button
              key={entry.round}
              type="button"
              className={[
                "pulse__round",
                entry.round === latestRound ? "is-latest" : "",
                entry.round === selectedRound ? "is-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() =>
                setSelectedRound((prev) => (prev === entry.round ? null : entry.round))
              }
              title={`round ${entry.round}`}
            >
              <span className="pulse__matrix">
                {lanes.length > 0 ? (
                  lanes.map((lane, laneIndex) => (
                    <span
                      key={lane.clusterId}
                      className={
                        entry.authors.has(laneIndex)
                          ? "pulse__cluster is-author"
                          : "pulse__cluster"
                      }
                      style={{ "--pulse-cols": Math.min(lane.size, 10) } as React.CSSProperties}
                    >
                      {Array.from({ length: lane.size }, (_, mi) => {
                        const globalIndex = lane.offset + mi;
                        const signer =
                          entry.cert.status === "ok" && entry.cert.signers.includes(globalIndex);
                        return (
                          <i
                            key={mi}
                            className={signer ? "pulse__dot is-signer" : "pulse__dot"}
                          />
                        );
                      })}
                    </span>
                  ))
                ) : (
                  <span
                    className="pulse__cluster"
                    style={{ "--pulse-cols": 7 } as React.CSSProperties}
                  >
                    {(entry.cert.status === "ok" ? entry.cert.signers : [...entry.authors.keys()]).map(
                      (idx) => (
                        <i
                          key={idx}
                          className={
                            entry.cert.status === "ok"
                              ? "pulse__dot is-signer"
                              : "pulse__dot is-evidence"
                          }
                        />
                      ),
                    )}
                  </span>
                )}
              </span>
              <span className="pulse__round-label">{entry.round}</span>
            </button>
          ))}
        </div>
      )}

      {selected ? (
        <RoundPopover entry={selected} lanes={lanes} onClose={() => setSelectedRound(null)} />
      ) : null}
    </div>
  );
}

function RoundPopover({
  entry,
  lanes,
  onClose,
}: {
  entry: PulseRound;
  lanes: ClusterLane[];
  onClose: () => void;
}) {
  type LeaderState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; digest: string; signerCount: number }
    | { status: "unavailable"; message: string };
  const [leader, setLeader] = useState<LeaderState>({ status: "idle" });

  useEffect(() => {
    setLeader({ status: "idle" });
  }, [entry.round]);

  const authors = [...entry.authors.entries()].sort((a, b) => a[0] - b[0]);
  const firstAuthor = authors[0] ?? null;

  const fetchLeaderCert = async () => {
    if (!firstAuthor) return;
    setLeader({ status: "loading" });
    try {
      const cert = (await rpc.lythGetLeaderCertificate(
        entry.round,
        firstAuthor[0],
        firstAuthor[1],
      )) as { signature?: unknown; signer_count?: unknown } | null;
      if (cert && typeof cert.signature === "string") {
        setLeader({
          status: "ok",
          digest: cert.signature,
          signerCount: typeof cert.signer_count === "number" ? cert.signer_count : 0,
        });
      } else {
        setLeader({ status: "unavailable", message: "leader certificate not persisted by this node" });
      }
    } catch (err) {
      setLeader({
        status: "unavailable",
        message: (err as Error)?.message ?? String(err),
      });
    }
  };

  return (
    <div className="pulse__pop" role="dialog" aria-label={`Round ${entry.round} certificate`}>
      <div className="pulse__pop-head">
        <b>Round {entry.round.toLocaleString()}</b>
        <button type="button" className="pulse__pop-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="pulse__pop-row">
        <span>height {entry.height !== null ? entry.height.toLocaleString() : "—"}</span>
        <span>
          {lanes.length > 0
            ? lanes.map((l) => `${l.threshold}-of-${l.size}`).join(" · ")
            : "threshold unknown"}
        </span>
      </div>

      {entry.commitHash ? (
        <div className="pulse__hash">
          <span className="cap">commit hash</span>
          <code>{groupHex(entry.commitHash)}</code>
          <CopyBtn text={entry.commitHash} />
        </div>
      ) : null}

      {entry.cert.status === "ok" ? (
        <>
          <div className="pulse__hash">
            <span className="cap">cert digest</span>
            <code>{entry.cert.digest ? groupHex(entry.cert.digest) : "—"}</code>
            {entry.cert.digest ? <CopyBtn text={entry.cert.digest} /> : null}
          </div>
          <div className="pulse__pop-row">
            <span>{entry.cert.signerCount} signers</span>
            <span>indices [{entry.cert.signers.join(", ")}]</span>
            {entry.cert.bitmap ? <span>bitmap {entry.cert.bitmap}</span> : null}
          </div>
        </>
      ) : entry.cert.status === "pending" ? (
        <div className="pulse__pop-note">Fetching the round certificate…</div>
      ) : entry.cert.status === "unsupported" ? (
        <div className="pulse__pop-note">
          Signer detail is not available from this node yet.
        </div>
      ) : entry.cert.status === "error" ? (
        <div className="pulse__pop-note">Certificate read failed: {entry.cert.message}</div>
      ) : (
        <div className="pulse__pop-note">
          Certificate not persisted by this node for round {entry.round}. Showing
          vertex authorship as fallback evidence — the round still committed.
        </div>
      )}

      <div className="pulse__pop-row">
        <span>
          vertex authors:{" "}
          {authors.length > 0 ? authors.map(([a]) => `seat ${a}`).join(", ") : "none observed"}
        </span>
      </div>
      {authors.map(([author, hash]) => (
        <div className="pulse__hash" key={author}>
          <span className="cap">seat {author} vertex</span>
          <code>{groupHex(hash)}</code>
          <CopyBtn text={hash} />
        </div>
      ))}

      {leader.status === "ok" ? (
        <div className="pulse__hash">
          <span className="cap">leader cert</span>
          <code>{groupHex(leader.digest)}</code>
          <CopyBtn text={leader.digest} />
        </div>
      ) : leader.status === "unavailable" ? (
        <div className="pulse__pop-note">Leader certificate: {leader.message}</div>
      ) : (
        <div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={!firstAuthor || leader.status === "loading"}
            title={firstAuthor ? undefined : "needs an observed vertex for this round"}
            onClick={() => void fetchLeaderCert()}
          >
            {leader.status === "loading" ? "Fetching leader certificate…" : "Fetch leader certificate"}
          </button>
        </div>
      )}
    </div>
  );
}
