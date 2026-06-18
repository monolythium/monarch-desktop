# ADR-0001 — Talos API credential hardening (least-privilege, secure storage, rotation)

Status: ACCEPTED (interim posture) — implementation STAGED
Scope: monarch-desktop provisioning + the Talos management credential (talosconfig)
Tracks: issue #8 (enhancement, mainnet-blocker)

## Context

Monarch mints one Talos management credential per node at provisioning time. As
of today that credential is:

- **Maximally privileged.** The talosconfig client cert is issued with
  `O=os:admin` (`provision.rs::generate_admin_client`). `os:admin` is the only
  Talos v1.13 RBAC role that can read file *content* over the MachineService
  `Copy` RPC, call `ApplyConfiguration`, and `reset`.
- **Immortal.** `ADMIN_CERT_VALIDITY_DAYS = 3650` (10 years) and
  `CA_VALIDITY_DAYS = 3650`. The app discards the machine CA key after
  provisioning, so there is **no renewal path and no revocation path** — a leaked
  client cert is full admin until the node is wiped (Monarch OS has no SSH
  fallback).
- **Stored as plaintext at rest.** `talos_maintenance::persist_talosconfig`
  writes the talosconfig (which embeds the admin Ed25519 private key) to
  `<appdata>/talosconfigs/<host>.talosconfig` protected only by Unix `0600` (no
  Windows ACL, no encryption-at-rest, no keychain).

## Decision

### Interim (testnet) posture — ACCEPTED NOW

The 10-year / non-revocable / `os:admin` posture is **accepted as
testnet-acceptable** and is a **mainnet blocker**. Operators run on dedicated /
operator-controlled hosts; the blast radius of a leaked talosconfig is one node,
recoverable by re-provision. This ADR is the decision record for that
acceptance.

### Hard feature constraint (why a naive least-privilege cut is WRONG)

`os:admin` is **required**, not optional, for:

- `talos_export_protocore_backup` and `talos_operator_seal_ek` — both use the
  MachineService `Copy` RPC (file-content read), granted ONLY to `os:admin`.
- `talos_set_log_retention` / `talos_clean_protocore_logs` /
  `talos_scrub_recovery_mnemonic` — all use `ApplyConfiguration`, `os:admin`.

A single reduced-role cert would BREAK backup / seal-ek / log-retention /
log-cleanup / mnemonic-scrub. The correct design is therefore a **dual-cert**
split (routine `os:reader`/`os:operator` + an `os:admin` elevation), which is a
multi-file behavioral change with real break-the-fleet risk and MUST be staged,
validated on a throwaway Talos node, and gated behind this ADR.

## What ships in this change (cleanly-safe, no behavior change)

1. **Posture recorded** (this ADR) — testnet-acceptable vs mainnet requirement.
2. **Rotation/validity scaffolding** — `PLANNED_ADMIN_CERT_VALIDITY_DAYS = 365`
   recorded in `provision.rs` as the post-renewal target, intentionally UNUSED so
   issuing behavior is unchanged (no node-bricking time-bomb).
3. **`/var` machine.files pin** (shared with #7) — `RECOVERY_MNEMONIC_PATH` is
   pinned under `/var/` with a guard test, since the recovery flow depends on the
   same Talos write-allowlist.

## Staged (NOT in this change — design-only)

- **Part 1 — keychain secure storage of the talosconfig body.** Move the
  credential body into the OS keychain and materialize a transient `0600` file in
  a non-synced cache dir at read time (every reader uses `TalosConfig::from_file`
  / `build_config_info`, both path-only). Migration: import + shred any legacy
  `<appdata>/talosconfigs/*.talosconfig`. **Risk:** a partial implementation can
  re-introduce the at-rest leak or leave temp files; it routes through
  `resolve_config`, used by EVERY talos command (incl. export / seal-ek), so it
  needs full-flow validation. Staged.
- **Part 2 — least-privilege dual-cert.** Issue an `os:reader`/`os:operator`
  routine cert + a separate `os:admin` cert; default to the routine cert; bind
  the admin cert (with a UI elevation step) to the 6
  `enforce_privileged_control_plane` sites + the 2 `Copy` sites. Requires
  Talos RBAC validation on a throwaway node. Staged.
- **Part 3 — validity reduction.** Drop `ADMIN_CERT_VALIDITY_DAYS` to
  `PLANNED_ADMIN_CERT_VALIDITY_DAYS` ONLY AFTER a renewal / CA-rotation path
  lands (persist the machine CA key encrypted in the keychain; re-issue via
  `ApplyConfiguration` of a rotated `trustdAcceptedCAs`; revoke a leaked client
  cert by rotating the machine CA without a full wipe). Staged.

## Consequences

The seat-preserving recovery hardening (#7) and the recover-keys reachability fix
(#9) ship now. The #8 attack surface (immortal `os:admin` plaintext credential)
remains the dominant pre-mainnet hardening item and is unblocked by the above
staged plan; none of it changes current behavior, so there is zero risk to
logs / status / OTA / provisioning / backup / seal-ek in this release.
