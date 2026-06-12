// Provision step (conditional) — install Monarch OS onto a fresh node.
//
// Reached only when the connect step detected a node in Talos maintenance mode
// (or the operator forced the install path). The node is booted but carries no
// machine config, so it does not serve RPC yet. This step:
//
//   1. summarises the maintenance-mode node and warns that provisioning
//      installs to a disk and reboots the box;
//   2. enumerates install disks over the insecure maintenance channel
//      (`talosMaintenanceDisks`), falling back to manual entry when the node
//      doesn't serve StorageService pre-config;
//   3. lets the operator pick a node mode (only `full` is provisionable in v1;
//      operator/signing needs an enrollment bundle the app can't produce yet);
//   4. generates the EXACT provisioning bundle Rust-side once per (host, disk)
//      (`talosGenerateFullNodeConfig`: machine config with the full cluster
//      PKI + the node's talosconfig) and previews the machine-config YAML —
//      the SAME bundle backs preview, dry-run and apply;
//   5. gates a destructive apply behind a clean dry-run AND a named-disk
//      confirmation checkbox;
//   6. applies + reboots (the committing apply also persists + registers the
//      talosconfig — the node's only management credential), then polls the
//      RPC endpoint (`probeNodeEndpoint`) through the reboot gap until the
//      node is live and serving chain id.
//
// Nothing is faked: the dry-run and apply go to the real Talos maintenance API
// via the Rust commands; bring-up is confirmed only by a real eth_chainId.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  probeNodeEndpoint,
  setStoredRpcEndpoint,
  talosGenerateFullNodeConfig,
  talosMaintenanceApply,
  talosMaintenanceDisks,
  validateDevice,
  type FullNodeConfig,
  type MaintenanceDisk,
  type MaintenanceProbe,
} from "../../sdk";
import { StepShell } from "./StepShell";

// Node mode the operator picks. Only `full` is applied in v1.
type NodeMode = "full" | "operator";

// Disk-enumeration lifecycle.
type DiskState =
  | { kind: "loading" }
  | { kind: "ready"; disks: MaintenanceDisk[] }
  | { kind: "manual"; reason: string };

// Apply / bring-up lifecycle.
type ApplyPhase = "idle" | "applying" | "waiting" | "live" | "timeout";

type DryRunState =
  | { kind: "none" }
  | { kind: "running" }
  | { kind: "ok"; output: string }
  | { kind: "err"; message: string };

// Rust-side provisioning-bundle generation lifecycle, keyed by `host|disk` so
// a stale bundle (different disk, different node) can never be applied.
type ConfigState =
  | { kind: "idle" }
  | { kind: "generating"; key: string }
  | { kind: "ready"; key: string; config: FullNodeConfig }
  | { kind: "err"; key: string; message: string };

// Debounce before asking Rust to mint a bundle: manual disk entry types
// through several transient values, and each generation mints a full PKI
// (RSA-4096 included — seconds of CPU).
const GENERATE_DEBOUNCE_MS = 500;

// Bring-up poll backoff: start at 3s, grow gently, cap at 15s; give up after
// ~5 minutes total (the reboot + first-boot genesis resolution is variable).
const POLL_START_MS = 3_000;
const POLL_MAX_MS = 15_000;
// A fresh node resolves genesis from chain-registry, builds its state DB, peers
// with the fleet, then binds RPC — usually 2–5 min, longer on a slow link.
const POLL_CEILING_MS = 8 * 60_000;

function isCdromish(disk: MaintenanceDisk): boolean {
  if (disk.readonly) return true;
  const t = disk.diskType.toLowerCase();
  return t.includes("cd") || t.includes("rom") || disk.deviceName.includes("/sr");
}

/** Default-select the largest non-readonly, non-cdrom disk (e.g. /dev/vda). */
function defaultDisk(disks: MaintenanceDisk[]): string {
  const eligible = disks.filter((d) => !isCdromish(d));
  if (eligible.length === 0) return "";
  return eligible.reduce((best, d) => (d.sizeBytes > best.sizeBytes ? d : best)).deviceName;
}

export function ProvisionStep({
  n,
  host,
  detectedProbe,
  onProvisioned,
}: {
  n: number;
  host: string;
  /** Maintenance probe carried over from the connect step, when available. */
  detectedProbe: MaintenanceProbe | null;
  /** Called with the node host once RPC is live; the wizard advances. */
  onProvisioned: (host: string) => void;
}) {
  const [diskState, setDiskState] = useState<DiskState>({ kind: "loading" });
  const [device, setDevice] = useState<string>("");
  const [manualDevice, setManualDevice] = useState<string>("");
  const [overrideAck, setOverrideAck] = useState(false);
  const [nodeMode, setNodeMode] = useState<NodeMode>("full");
  const [confirmed, setConfirmed] = useState(false);
  const [dryRun, setDryRun] = useState<DryRunState>({ kind: "none" });
  const [phase, setPhase] = useState<ApplyPhase>("idle");
  const [applyOutput, setApplyOutput] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [liveChainId, setLiveChainId] = useState<number | null>(null);
  const [pollAttempts, setPollAttempts] = useState(0);
  const [pollElapsedMs, setPollElapsedMs] = useState(0);
  // The full provisioning bundle (machine config + talosconfig), minted
  // Rust-side once per (host, disk). The SAME bundle backs preview, dry-run
  // and apply — never regenerate between a green dry-run and the apply.
  const [configState, setConfigState] = useState<ConfigState>({ kind: "idle" });
  // Where the committing apply persisted the node's talosconfig (or why it
  // couldn't) — the node's only management credential.
  const [talosconfigPath, setTalosconfigPath] = useState<string | null>(null);
  const [talosconfigSaveError, setTalosconfigSaveError] = useState<string | null>(null);
  const cancelPoll = useRef(false);
  const configStateRef = useRef<ConfigState>(configState);
  configStateRef.current = configState;

  // The applied config always targets a FULL node (operator mode is deferred).
  // We still surface the operator option so the choice is honest, but the YAML
  // is full either way.
  const effectiveDisk = diskState.kind === "manual" ? manualDevice : device;
  const configYaml =
    configState.kind === "ready"
      ? configState.config.configYaml
      : configState.kind === "err"
        ? `# could not generate this node's machine config: ${configState.message}`
        : configState.kind === "generating"
          ? "# generating this node's machine config + PKI (a few seconds)…"
          : "# choose an install disk to preview the machine config";

  // Enumerate disks on mount over the insecure maintenance channel.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const disks = await talosMaintenanceDisks(host);
        if (cancelled) return;
        if (disks.length === 0) {
          setDiskState({
            kind: "manual",
            reason: "This node reported no disks over the maintenance API — enter the install device manually.",
          });
          setManualDevice("/dev/vda");
          return;
        }
        setDiskState({ kind: "ready", disks });
        setDevice(defaultDisk(disks));
      } catch (err) {
        if (cancelled) return;
        setDiskState({
          kind: "manual",
          reason: `Disk enumeration unavailable (${(err as Error)?.message ?? String(err)}) — enter the install device manually.`,
        });
        setManualDevice("/dev/vda");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host]);

  // Mint the provisioning bundle Rust-side once per (host, disk): the machine
  // config with the node's full PKI plus its talosconfig. Debounced (manual
  // disk entry types through transient values) and keyed so an already-ready
  // bundle for the same target is never regenerated — the YAML shown, the
  // YAML dry-run and the YAML applied must be the same bytes.
  useEffect(() => {
    const disk = effectiveDisk.trim();
    if (!disk) {
      setConfigState({ kind: "idle" });
      return;
    }
    const key = `${host}|${disk}`;
    const prev = configStateRef.current;
    if (prev.kind === "ready" && prev.key === key) return;
    setConfigState({ kind: "generating", key });
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const config = await talosGenerateFullNodeConfig(host, disk);
          if (!cancelled) setConfigState({ kind: "ready", key, config });
        } catch (err) {
          if (!cancelled) {
            setConfigState({ kind: "err", key, message: (err as Error)?.message ?? String(err) });
          }
        }
      })();
    }, GENERATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [host, effectiveDisk]);

  // Validate the chosen device. In manual mode an unknown device requires the
  // explicit override ack; an enumerated device is validated against the list.
  const enumerated = diskState.kind === "ready" ? diskState.disks : [];
  const deviceValidation =
    diskState.kind === "manual"
      ? manualDevice.trim()
        ? overrideAck
          ? { ok: true as const }
          : { ok: false as const, reason: "Tick the box below to confirm this device, since Monarch couldn't enumerate the node's disks." }
        : { ok: false as const, reason: "Enter the install device." }
      : validateDevice(device, enumerated);

  const configReady =
    configState.kind === "ready" && configState.key === `${host}|${effectiveDisk.trim()}`;
  const canDryRun =
    phase === "idle" &&
    effectiveDisk.length > 0 &&
    deviceValidation.ok &&
    configReady &&
    dryRun.kind !== "running";
  const canApply =
    phase === "idle" && dryRun.kind === "ok" && confirmed && deviceValidation.ok && configReady;

  const runDryRun = useCallback(async () => {
    if (configState.kind !== "ready") return;
    setDryRun({ kind: "running" });
    setApplyError(null);
    try {
      const result = await talosMaintenanceApply({
        host,
        configYaml: configState.config.configYaml,
        dryRun: true,
        mode: "try",
      });
      setDryRun({ kind: "ok", output: result.output });
    } catch (err) {
      setDryRun({ kind: "err", message: (err as Error)?.message ?? String(err) });
    }
  }, [host, configState]);

  // Any change to the previewed YAML (disk switch, bundle regeneration) after
  // a green dry-run invalidates it — what gets applied must be what was
  // dry-run.
  useEffect(() => {
    setDryRun((prev) => (prev.kind === "ok" ? { kind: "none" } : prev));
    setConfirmed(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configYaml]);

  // Bring-up poller: tolerate the reboot gap, poll RPC on backoff until the
  // node answers eth_chainId, then persist + hand off.
  const startBringUp = useCallback(async () => {
    cancelPoll.current = false;
    setPhase("waiting");
    setPollAttempts(0);
    setPollElapsedMs(0);
    const endpoint = `http://${host}:8545`;
    let delay = POLL_START_MS;
    let elapsed = 0;
    // Initial settle: the node is rebooting; don't hammer it immediately.
    await sleep(delay);
    elapsed += delay;
    setPollElapsedMs(elapsed);
    while (!cancelPoll.current && elapsed < POLL_CEILING_MS) {
      setPollAttempts((a) => a + 1);
      try {
        const probe = await probeNodeEndpoint(endpoint);
        if (probe.outcome === "ok") {
          setStoredRpcEndpoint(endpoint);
          setLiveChainId(probe.chainId);
          setPhase("live");
          onProvisioned(host);
          return;
        }
      } catch {
        // Transient — the node is still coming back. Keep polling.
      }
      if (cancelPoll.current) return;
      await sleep(delay);
      elapsed += delay;
      setPollElapsedMs(elapsed);
      delay = Math.min(Math.round(delay * 1.3), POLL_MAX_MS);
    }
    if (!cancelPoll.current) setPhase("timeout");
  }, [host, onProvisioned]);

  const runApply = useCallback(async () => {
    if (configState.kind !== "ready") return;
    setApplyError(null);
    setPhase("applying");
    try {
      const result = await talosMaintenanceApply({
        host,
        configYaml: configState.config.configYaml,
        dryRun: false,
        mode: "reboot",
        // The committing apply also persists + registers the node's
        // talosconfig (its ONLY management credential — no SSH on Monarch OS).
        talosconfigYaml: configState.config.talosconfigYaml,
      });
      setApplyOutput(result.output);
      setTalosconfigPath(result.talosconfigPath ?? null);
      setTalosconfigSaveError(result.talosconfigError ?? null);
      // The node now writes config, installs, and reboots — the :50000
      // maintenance API drops. That connection loss is EXPECTED, not an error;
      // move straight into the RPC bring-up poll.
      void startBringUp();
    } catch (err) {
      // A reject here means the node refused the apply BEFORE rebooting (config
      // invalid, channel lost mid-call). Surface it; the operator can retry.
      setApplyError((err as Error)?.message ?? String(err));
      setPhase("idle");
    }
  }, [host, configState, startBringUp]);

  // Cancel any in-flight poll on unmount.
  useEffect(() => {
    return () => {
      cancelPoll.current = true;
    };
  }, []);

  const recheck = useCallback(() => {
    if (phase === "waiting" || phase === "applying") return;
    void startBringUp();
  }, [phase, startBringUp]);

  const inProgress = phase === "applying" || phase === "waiting";

  return (
    <StepShell
      n={n}
      title="Provision this node"
      sub="This node is booted in maintenance mode but isn't configured yet. Install Monarch OS to a disk and bring it up as a full node serving RPC."
    >
      {/* Maintenance summary + destructive warning. */}
      <div style={{ display: "grid", gap: 10 }}>
        <div className="halo halo--info" style={{ alignSelf: "flex-start" }}>
          <span className="dot" /> node in maintenance mode
          {detectedProbe?.talosVersion ? ` · Talos ${detectedProbe.talosVersion}` : ""}
        </div>
        <div className="kv">
          <span className="kv__k">node host</span>
          <span className="kv__v mono">{host || "—"}</span>
        </div>
        <div
          className="halo halo--warn"
          style={{ alignSelf: "stretch", whiteSpace: "normal", lineHeight: 1.5, alignItems: "flex-start" }}
        >
          <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
          <span>
            This <b>installs Monarch OS to a disk and reboots the node</b>. Pick the right install
            disk — anything on it is replaced. The RPC (:8545) and Talos (:50000) endpoints should be
            reachable only on your operator network, never the public internet.
          </span>
        </div>
      </div>

      {/* Disk picker. */}
      <div className="setup__field" style={{ marginTop: 18 }}>
        <label className="cap">install disk</label>

        {diskState.kind === "loading" ? (
          <div className="halo halo--info" style={{ alignSelf: "flex-start" }}>
            <span className="dot dot--pulse" /> enumerating disks…
          </div>
        ) : null}

        {diskState.kind === "ready" ? (
          <div style={{ display: "grid", gap: 8 }}>
            {diskState.disks.map((disk) => {
              const blocked = isCdromish(disk);
              const selected = !blocked && device === disk.deviceName;
              return (
                <button
                  key={disk.deviceName}
                  type="button"
                  disabled={blocked || inProgress}
                  className={`setup__toggle-opt${selected ? " setup__toggle-opt--on" : ""}`}
                  style={{
                    width: "100%",
                    opacity: blocked ? 0.5 : 1,
                    cursor: blocked ? "not-allowed" : "pointer",
                  }}
                  onClick={() => !blocked && setDevice(disk.deviceName)}
                  title={blocked ? "read-only / removable media — not an install target" : undefined}
                >
                  <b style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span className="mono">{disk.deviceName}</span>
                    <span style={{ color: "var(--fg-300)", fontWeight: 400 }}>{disk.sizeHuman}</span>
                  </b>
                  <span>
                    {disk.model || "unknown model"} · {disk.diskType || "disk"}
                    {disk.systemDiskHint ? " · system-disk hint" : ""}
                    {blocked ? " · read-only / removable" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {diskState.kind === "manual" ? (
          <div style={{ display: "grid", gap: 8 }}>
            <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: 0, lineHeight: 1.5 }}>
              {diskState.reason}
            </p>
            <input
              className="setup__input mono"
              placeholder="/dev/vda"
              value={manualDevice}
              onChange={(e) => setManualDevice(e.target.value)}
              disabled={inProgress}
              spellCheck={false}
              autoComplete="off"
            />
            <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, color: "var(--fg-300)" }}>
              <input
                type="checkbox"
                checked={overrideAck}
                onChange={(e) => setOverrideAck(e.target.checked)}
                disabled={inProgress}
                style={{ marginTop: 2 }}
              />
              <span>
                I've confirmed <span className="mono">{manualDevice.trim() || "/dev/…"}</span> is the
                correct install device on this node.
              </span>
            </label>
          </div>
        ) : null}

        {!deviceValidation.ok && diskState.kind !== "loading" && effectiveDisk ? (
          <span className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> {deviceValidation.reason}
          </span>
        ) : null}
      </div>

      {/* Node-mode selector. */}
      <div className="setup__field" style={{ marginTop: 18 }}>
        <label className="cap">node mode</label>
        <div className="setup__toggle" style={{ marginTop: 0 }}>
          <button
            type="button"
            disabled={inProgress}
            className={`setup__toggle-opt${nodeMode === "full" ? " setup__toggle-opt--on" : ""}`}
            onClick={() => setNodeMode("full")}
          >
            <b>Full node</b>
            <span>Relay / RPC — syncs and serves the chain, no signing. This is what gets installed.</span>
          </button>
          <button
            type="button"
            disabled={inProgress}
            className={`setup__toggle-opt${nodeMode === "operator" ? " setup__toggle-opt--on" : ""}`}
            onClick={() => setNodeMode("operator")}
          >
            <b>Operator (signing)</b>
            <span>Set up signing after the node is live — operator enrollment isn't wired into provisioning yet.</span>
          </button>
        </div>
        {nodeMode === "operator" ? (
          <span
            className="halo halo--info"
            style={{ alignSelf: "stretch", whiteSpace: "normal", lineHeight: 1.5, alignItems: "flex-start", marginTop: 8 }}
          >
            <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
            <span>
              In-app provisioning installs a <b>full node</b>. Operator (signing) provisioning needs
              an enrollment bundle Monarch can't produce yet — provision the full node now, then add
              an operator key and register it in the next steps. The applied config stays{" "}
              <span className="mono">PROTOCORE_NODE_MODE=full</span>.
            </span>
          </span>
        ) : null}
      </div>

      {/* Config preview. */}
      <div className="setup__field" style={{ marginTop: 18 }}>
        <label className="cap">machine config to apply</label>
        <pre
          className="mono"
          style={{
            margin: 0,
            padding: "12px 14px",
            background: "rgba(0,0,0,0.32)",
            border: "1px solid var(--glass-stroke)",
            borderRadius: "var(--r-sm)",
            color: "var(--fg-200)",
            fontSize: 11.5,
            lineHeight: 1.5,
            overflowX: "auto",
            whiteSpace: "pre",
          }}
        >
          {configYaml}
        </pre>
      </div>

      {/* Dry-run + apply, gated behind a named-disk confirmation. Once apply
          fires the progress panel below takes over (phase !== "idle"). */}
      {phase === "idle" ? (
        <div style={{ display: "grid", gap: 12, marginTop: 18 }}>
          {dryRun.kind === "ok" ? (
            <div className="setup__result setup__result--ok">
              <div className="halo halo--ok" style={{ alignSelf: "flex-start" }}>
                <span className="dot" /> dry-run accepted
              </div>
              <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-300)", whiteSpace: "pre-wrap" }}>
                {dryRun.output}
              </pre>
            </div>
          ) : null}
          {dryRun.kind === "err" ? (
            <div className="setup__result setup__result--err">
              <div className="halo halo--err" style={{ alignSelf: "flex-start" }}>
                <span className="dot" /> dry-run rejected
              </div>
              <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-300)", whiteSpace: "pre-wrap" }}>
                {dryRun.message}
              </pre>
            </div>
          ) : null}
          {applyError ? (
            <div className="setup__result setup__result--err">
              <div className="halo halo--err" style={{ alignSelf: "flex-start" }}>
                <span className="dot" /> apply failed
              </div>
              <pre className="mono" style={{ margin: "8px 0 0", fontSize: 11, color: "var(--fg-300)", whiteSpace: "pre-wrap" }}>
                {applyError}
              </pre>
            </div>
          ) : null}

          <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12.5, color: "var(--fg-200)" }}>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              style={{ marginTop: 2 }}
            />
            <span>
              I understand this installs Monarch OS to{" "}
              <span className="mono" style={{ color: "var(--fg-100)" }}>{effectiveDisk || "/dev/…"}</span>{" "}
              and reboots <span className="mono" style={{ color: "var(--fg-100)" }}>{host}</span>.
            </span>
          </label>

          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => void runDryRun()}
              disabled={!canDryRun}
            >
              {dryRun.kind === "running" ? "Checking…" : "Dry-run check"}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void runApply()}
              disabled={!canApply}
            >
              Apply &amp; install
            </button>
            {dryRun.kind !== "ok" ? (
              <span style={{ fontSize: 11.5, color: "var(--fg-400)" }}>
                Run a clean dry-run and tick the box to enable Apply.
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* Bring-up progress. */}
      {phase !== "idle" ? (
        <div style={{ marginTop: 20 }}>
          <ProgressPanel
            phase={phase}
            applyOutput={applyOutput}
            pollAttempts={pollAttempts}
            pollElapsedMs={pollElapsedMs}
            chainId={liveChainId}
            host={host}
          />
          <TalosconfigCard
            path={talosconfigPath}
            saveError={talosconfigSaveError}
            talosconfigYaml={
              configState.kind === "ready" ? configState.config.talosconfigYaml : null
            }
          />
          {phase === "timeout" ? (
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button type="button" className="btn btn--primary btn--sm" onClick={recheck}>
                Re-check now
              </button>
              <span style={{ fontSize: 11.5, color: "var(--fg-400)", lineHeight: 1.5, flex: 1 }}>
                The node hasn't served RPC yet. If it never comes up, the install may have failed —
                re-flash the Monarch OS image and provision again. A node that didn't reboot can be
                retried from the connect step.
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </StepShell>
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post-apply talosconfig card: where the node's management credential was
 * saved (the Rust side persisted + registered it), with copy affordances. On
 * a save failure this is the operator's LAST chance to keep the credential —
 * the copy button hands over the full talosconfig YAML.
 */
function TalosconfigCard({
  path,
  saveError,
  talosconfigYaml,
}: {
  path: string | null;
  saveError: string | null;
  talosconfigYaml: string | null;
}) {
  const [copied, setCopied] = useState<"path" | "yaml" | null>(null);
  const copy = useCallback((kind: "path" | "yaml", text: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(kind);
        setTimeout(() => setCopied((prev) => (prev === kind ? null : prev)), 2000);
      })
      .catch(() => {
        // Clipboard refusal (focus/permissions) — leave the value visible.
      });
  }, []);

  if (!path && !saveError) return null;

  return (
    <div className="card" style={{ marginTop: 12, padding: "14px 18px", display: "grid", gap: 10 }}>
      {path ? (
        <>
          <div className="halo halo--ok" style={{ alignSelf: "flex-start" }}>
            <span className="dot" /> talosconfig saved
          </div>
          <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: 0, lineHeight: 1.55 }}>
            This file is the only credential that can manage this node — Monarch OS has no SSH.
            Monarch registered it for the Hardware / Install views and keeps it at:
          </p>
          <div
            className="mono"
            style={{
              fontSize: 11,
              color: "var(--fg-200)",
              padding: "8px 10px",
              background: "rgba(0,0,0,0.32)",
              border: "1px solid var(--glass-stroke)",
              borderRadius: "var(--r-sm)",
              overflowX: "auto",
              whiteSpace: "nowrap",
            }}
          >
            {path}
          </div>
        </>
      ) : null}
      {saveError ? (
        <div
          className="halo halo--err"
          style={{ alignSelf: "stretch", whiteSpace: "normal", lineHeight: 1.5, alignItems: "flex-start" }}
        >
          <span className="dot" style={{ marginTop: 4, flex: "0 0 auto" }} />
          <span>{saveError}</span>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        {path ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => copy("path", path)}>
            {copied === "path" ? "Copied" : "Copy path"}
          </button>
        ) : null}
        {talosconfigYaml ? (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => copy("yaml", talosconfigYaml)}
          >
            {copied === "yaml" ? "Copied" : "Copy talosconfig"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// Reuse the Install.tsx three-phase badge/halo/text vocabulary so bring-up
// reads the same as node pairing.
type RowStatus = "checking" | "done" | "todo" | "unknown";

function ProgressPanel({
  phase,
  applyOutput,
  pollAttempts,
  pollElapsedMs,
  chainId,
  host,
}: {
  phase: ApplyPhase;
  applyOutput: string | null;
  pollAttempts: number;
  pollElapsedMs: number;
  chainId: number | null;
  host: string;
}) {
  const elapsedSec = Math.floor(pollElapsedMs / 1000);
  const elapsedLabel = `${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")}`;
  // Time-based progress against the poll ceiling — a fresh node usually serves
  // RPC well before the ceiling, so this reads as "how long has it been" rather
  // than a hard deadline.
  const pct = Math.min(100, Math.round((pollElapsedMs / POLL_CEILING_MS) * 100));
  const rows: Array<{ label: string; detail: string; status: RowStatus }> = [
    {
      label: "Applying config & rebooting",
      detail: "config written, Monarch OS installs to disk, node reboots (the maintenance API drops — expected)",
      status: phase === "applying" ? "checking" : "done",
    },
    {
      label: "Node coming back",
      detail: "Talos reboots and starts the protocore system extension",
      status: phase === "applying" ? "unknown" : phase === "live" ? "done" : "checking",
    },
    {
      label: "Serving RPC",
      detail: chainId !== null
        ? `eth_chainId answered (chain ${chainId}) at http://${host}:8545`
        : `polling http://${host}:8545 for eth_chainId · attempt ${pollAttempts}`,
      status: phase === "live" ? "done" : phase === "timeout" ? "todo" : phase === "waiting" ? "checking" : "unknown",
    },
  ];

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {rows.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: "grid",
            gridTemplateColumns: "auto 1fr auto",
            gap: 16,
            padding: "14px 18px",
            alignItems: "center",
            borderTop: i > 0 ? "1px solid var(--glass-stroke)" : "none",
          }}
        >
          <StepBadge status={row.status} index={i} />
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--fg-100)" }}>{row.label}</div>
            <div className="mono" style={{ fontSize: 11, color: "var(--fg-400)", marginTop: 3 }}>
              {row.detail}
            </div>
          </div>
          <span className={statusHalo(row.status)} style={{ letterSpacing: "0.08em" }}>
            {statusText(row.status)}
          </span>
        </div>
      ))}
      {applyOutput ? (
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--glass-stroke)", background: "rgba(255,255,255,0.02)" }}>
          <div className="cap" style={{ marginBottom: 6 }}>talos apply output</div>
          <pre className="mono" style={{ margin: 0, fontSize: 10.5, color: "var(--fg-400)", whiteSpace: "pre-wrap" }}>
            {applyOutput}
          </pre>
        </div>
      ) : null}
      {phase === "waiting" ? (
        <div style={{ padding: "14px 18px", borderTop: "1px solid var(--glass-stroke)", background: "rgba(255,255,255,0.02)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
            <span style={{ fontSize: 12, color: "var(--fg-200)", fontWeight: 500 }}>Bringing the node up…</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--fg-400)" }}>{elapsedLabel} elapsed · attempt {pollAttempts}</span>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: "rgba(255,255,255,0.07)", overflow: "hidden" }}>
            <div
              style={{
                height: "100%",
                width: `${Math.max(4, pct)}%`,
                borderRadius: 999,
                background: "linear-gradient(90deg, var(--gold-lo, var(--gold)), var(--gold))",
                transition: "width 600ms var(--e-out, ease)",
              }}
            />
          </div>
          <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: "10px 0 0", lineHeight: 1.55 }}>
            This is normal — a fresh node resolves genesis from the chain registry, builds its state
            database, peers with the network, and then starts serving RPC. It usually takes <b style={{ color: "var(--fg-200)" }}>2–5 minutes</b>{" "}
            (longer on a slow connection). You can leave this running — Monarch will connect automatically the moment it's ready.
          </p>
        </div>
      ) : null}
      {phase === "live" ? (
        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--glass-stroke)", background: "oklch(0.78 0.16 155 / 0.06)" }}>
          <span className="halo halo--ok"><span className="dot" /> Node is live and serving RPC</span>
        </div>
      ) : null}
    </div>
  );
}

function statusHalo(status: RowStatus): string {
  if (status === "done") return "halo halo--ok";
  if (status === "checking") return "halo halo--info";
  if (status === "todo") return "halo halo--gold";
  return "halo halo--warn";
}

function statusText(status: RowStatus): string {
  if (status === "done") return "DONE";
  if (status === "checking") return "WORKING";
  if (status === "todo") return "WAITING";
  return "—";
}

function StepBadge({ status, index }: { status: RowStatus; index: number }) {
  const colors = {
    done: { bg: "oklch(0.30 0.08 155)", border: "oklch(0.55 0.15 155)", fg: "oklch(0.82 0.16 155)", glow: "none" },
    todo: { bg: "rgba(242,180,65,0.18)", border: "var(--gold)", fg: "var(--gold)", glow: "0 0 16px rgba(242,180,65,0.3)" },
    checking: { bg: "rgba(255,255,255,0.04)", border: "var(--glass-stroke)", fg: "var(--fg-300)", glow: "none" },
    unknown: { bg: "rgba(255,255,255,0.04)", border: "var(--glass-stroke)", fg: "var(--fg-400)", glow: "none" },
  } as const;
  const c = colors[status];
  return (
    <div
      style={{
        width: 34,
        height: 34,
        borderRadius: 10,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.fg,
        boxShadow: c.glow,
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--f-mono)",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      {status === "done" ? "✓" : index + 1}
    </div>
  );
}
