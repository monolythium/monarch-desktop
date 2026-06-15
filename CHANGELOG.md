# Changelog

All notable changes to Monarch Desktop are recorded here. This project adheres
to semantic-ish versioning while pre-1.0 (patch bumps for fixes and small
features, minor bumps for larger surface changes).

## 0.0.40 — 2026-06-15

### Fixed

- **A healthy synced node no longer reads as "STAGE Booting / READY False".**
  Readiness now treats *any* well-formed JSON-RPC answer — including a structured
  error such as `-32045` "method disabled" — as proof the node is up and serving,
  instead of requiring `eth_chainId` + `eth_blockNumber` to return chain data.
  Operators who narrow their RPC profile (gating the `eth_*` compat namespace)
  were seeing a fully synced node painted as "Booting" and the Hardware/Services
  `ext-protocore` card as red/degraded; it now classifies as serving-rpc/ok. When
  the chain-data methods are gated, readiness falls back to `lyth_chainStatus` /
  `lyth_syncStatus` for the chain id / height / sync state. A node that answers
  *nothing* (pure transport failure) still reads as not-yet-serving, and an
  answering node that genuinely reports `syncing=true` still reads as syncing.

- **Graceful-restart impact copy is correct for relay / non-consensus nodes.** A
  node with no consensus seat (`clusterId === null`) no longer renders cluster-0
  quorum math or the bogus "your seat was not matched in this cluster" note when
  you stop/restart it. It now states plainly: "This node is not a consensus
  operator — restarting has no committee/quorum impact." The cluster-status read
  passes the node's own seat through verbatim (no `DEFAULT_ACTIVE_CLUSTER_ID`
  laundering), so a relay/standalone never pulls another cluster's roster.

- **Logs panel now streams the node's protocore logs.** The Talos `Logs`
  request was built for containerd container logs (`system` namespace,
  Containerd driver), but `ext-protocore` is a Talos extension *service*, not a
  container — so the stream opened empty and the panel sat on "Connected.
  Waiting for logs" forever. The request now mirrors `talosctl logs
  ext-protocore` (empty namespace, keyed on the service `id`), so the one-shot
  tail and follow stream actually carry the service log. The line parser also
  learned protocore's `--log-format json` (tracing-subscriber) shape and plain
  text lines, instead of only journald JSON, so real lines render with level
  pills and timestamps.

- **Release-match no longer cries "could not match" for a dev build.** When the
  node reports a real git commit that matches no published signed release (an
  unreleased / dev build), the topbar chip and the Attestation page now show it
  honestly as `node: dev <short-commit>` / "running an unreleased build", while
  still offering the latest signed release to apply. A genuinely unidentifiable
  node (no commit reported) keeps the "could not match" wording — the two states
  are now distinct.

### Added

- **Log management surface (Logs view).** Shows the real disk usage of
  `/var/lib/protocore/logs` (size + per-file breakdown, largest first) read over
  the Talos `DiskUsage`/`List` RPCs — the protocore log appends without rotating
  and reached 10GB on the live fleet. Two guarded Operations:
  - **Set log retention** — patches the protocore extension env
    (`PROTOCORE_LOG_MAX_BYTES` / `PROTOCORE_LOG_MAX_FILES`) via Talos
    `ApplyConfiguration` (NoReboot), the immutable-node-correct way to bound the
    log.
  - **Clean up logs** — applies the retention bound and restarts ext-protocore
    so it takes effect. Note: Talos exposes no file-truncate RPC, so the bytes
    already on disk are reclaimed by the extension's rotation under the bound,
    not by a direct truncate; the UI states this plainly.
  - New Tauri commands `talos_log_disk_usage`, `talos_set_log_retention`,
    `talos_clean_protocore_logs` with bridge wrappers and ops-catalog entries.

### Notes

- The unbounded growth of `/var/lib/protocore/logs/protocore.log` (the systemd
  `append:` redirect never rotates) is a node-side concern in the protocore
  extension / mono-core tracing subscriber. The durable fix (a size cap honored
  by the extension's log writer) lands there; this release gives operators the
  visibility and the config-patch path from the desktop.
