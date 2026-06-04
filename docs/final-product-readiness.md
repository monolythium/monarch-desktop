# Final Product Readiness

This document tracks what Monarch Desktop still needs before it is a production operator GUI for Monarch OS. The production app must control Monarch OS through Talos API mTLS and read chain state through Protocore RPC. It must not silently fall back to fabricated data for production decisions.

## Current State

| Area | Current state |
| --- | --- |
| Shell | Tauri 2 desktop shell exists. |
| Frontend | React views exist for home, cluster, node identity, logs, metrics, hardware, install, operations, and Ask Monarch. |
| Keychain | Native keychain helpers exist. |
| RPC | SDK/RPC hooks exist for live chain, retained metrics range, cluster, cluster resignations, operator identity, operator authority, risk, signing activity, upcoming duties, and selected precompile/indexer reads. |
| Operations | Operations drawer and explicit approval flow exist. Start/stop/restart run through Talos service actions, operator-register signs the node-registry tx, redelegate signs the delegation-precompile tx from the operator keychain mnemonic, chat peer publication signs `setChatBootstrapPeers(bytes32,bytes)` from the operator keychain mnemonic, offline Protocore backup export streams `/var/lib/protocore` through Talos Copy only when `ext-protocore` is stopped and is accepted by the OS restore runbook only with signed release metadata, OS upgrade calls Talos Upgrade with `preserve=true`, and OS rollback calls Talos Rollback. Terminal receipts are stamped as `monarch-desktop-operation-receipt/v1` with a canonical SHA-256 audit payload hash. |
| Ask Monarch | Ask Monarch is live-provider only: Hosted/Local replies may propose drawer actions, but browser/no-provider/error paths show an error state and no suggested action instead of canned operational incidents. |
| Dev control bridge | SSH bridge exists for plain Linux development hosts. |
| Monarch OS control | Native Talos API mTLS bridge is implemented through `talos-rust-client`, with config selection, certificate diagnostics, CA fingerprint trust, certificate expiry-horizon evidence, service actions, log streaming, host telemetry, and a Protocore readiness probe that combines Talos service state with live JSON-RPC checks. Privileged Talos service actions require a matched trusted CA pin, a selected endpoint in the active talosconfig context, and valid CA/client certificates. The release-readiness gate also fails when Talos certificates are inside the 14-day rotation window. |
| Release attestation | Operators can store the expected `protocore` SHA-256 digest in the OS keychain, compare it against live `lyth_runtimeProvenance`, and see the result beside OS service state. |
| Release readiness gate | `src/sdk/releaseReadiness.ts` defines a tested release gate that requires Talos identity pinning, healthy Protocore RPC readiness, matched release digest attestation, audit-ready successful Talos operation receipts, and verified two-party chat evidence whose signed sender addresses are proven against the active cluster roster through `lyth_clusterStatus` plus `lyth_operatorInfo`. The Rust chat runtime now applies that same membership proof before local cluster join, before local send, before restoring persisted subscriptions, and before persisting inbound peer messages. Chat history now persists restart-auditable signed-envelope fields (`cluster_id`, sender pubkey, nonce, signature, and message id), re-verifies persisted rows when history is read, and release readiness rejects chat messages missing those fields or carrying empty bodies. `src/sdk/e2eRecorder.ts` provides an opt-in `VITE_MONARCH_E2E_RECORDER=true` recorder for real GUI route and Tauri-command evidence. `src/sdk/releaseE2eEvidence.ts` plus `pnpm run verify:e2e-evidence -- <file>` verify the JSON artifact a real GUI/Tauri e2e harness must emit, including binding Desktop's expected/live runtime digest to the Monarch OS release metadata digest, rejecting missing DKG re-share attestation artifacts, rejecting operation receipts missing the `monarch-desktop-operation-receipt/v1` audit hash, and rejecting the same incomplete chat signed-envelope fields as the in-app readiness gate. `pnpm run e2e:tauri` now launches a recorder-enabled Tauri app through `tauri-driver`, clicks the required routes, can seed Talos/keychain settings in-app, imports the OS-rendered DKG attestation artifact, collects Desktop readiness unless `--readiness <file>` is supplied, merges route/command evidence with Monarch OS QEMU smoke, and verifies the generated artifact. `pnpm run e2e:monarch` wraps the OS smoke keepalive lifecycle and the Desktop harness, using the OS smoke live env digest when release metadata is present. The release workflow runs terminology/source-copy enforcement, frontend typecheck/tests, and Rust tests before packaging, can verify a supplied evidence file through `desktop_e2e_evidence`, and now requires the Linux `gui-e2e` orchestrator before tagged release packaging or manual release-tag dispatch. |
| Production wording | `pnpm run check:release-terminology` now scans release surfaces for open implementation markers, fake/mock-facing runtime copy, and retired chain-role labels before signed packaging. |

## Missing From The Final Version

| Area | Missing | Required final behavior |
| --- | --- | --- |
| Operations execution | Start/stop/restart are mapped to Talos service actions; operator-register and redelegate submit signed PQM-1 native transactions through the SDK and record tx-hash receipts; chat peer publication builds `setChatBootstrapPeers(bytes32,bytes)` calldata, validates the 32-byte peer id plus bounded libp2p `/p2p/` multiaddrs, submits a zero-value operator-signed node-registry tx, and records `chat-bootstrap-peers-tx` receipts; operator-restore builds `recoverOperatorNode(bytes32)` calldata, reads a foundation operations PQM-1 mnemonic from the OS keychain only when present, submits the foundation-gated node-registry tx, and records the tx hash under `foundation-recovery-tx`. Cluster invite and cluster slot swap build `submitPendingChange(uint8,bytes,uint64,uint64)` calldata for Add and Rotate respectively, require ML-DSA-65 consensus pubkey/effective epoch inputs (plus a non-zero uint56 intent id for Rotate), submit a foundation-gated node-registry tx through the same signer, and record `foundation-pending-change-tx` receipts. Rotate-key/DKG attestation now builds `attestDkgReshare(uint64,bytes,bytes)` calldata from the ceremony output, validates 5..7 unique ML-DSA-65 consensus pubkeys plus one ML-DSA-65 attestation signature per signer, imports the OS-rendered `monarch-dkg-reshare-attestation/v1` JSON artifact when supplied, submits the operator-signed node-registry tx, and records `dkg-reshare-tx` receipts. Ordinary operator installs leave the foundation key absent and fail closed for foundation-gated calls before broadcast. Export-backup now uses Talos Copy to stream `/var/lib/protocore` into a local `.tar.gz` plus `.backup.json` manifest and refuses to run unless `ext-protocore` is stopped/offline. The OS `protocore-offline-restore` runbook accepts that Desktop manifest only when the operator supplies signed OS release metadata, so the restore evidence is bound to chain, genesis, and Protocore digest rather than just the local archive. OS upgrade/rollback now route through Talos Upgrade/Rollback after drawer approval. Upgrade requires a tagged or digest image reference, enforces `preserve=true`, and records the Talos endpoint/node in the receipt. Each terminal operation now emits a local receipt with status, transport, service/action, endpoint/node, tx hash when present, and backup manifest path/SHA when present; each receipt also carries the `monarch-desktop-operation-receipt/v1` schema marker and canonical audit payload SHA-256 so OS audit-trail evidence can bind to the exact Desktop operation result. The drawer shows the receipt id. Tauri execution fails closed on Talos trust/certificate errors instead of trying SSH. Remaining key-rotation gap: Desktop still consumes externally produced key-share ceremony output; it does not run the DKG ceremony or TPM-seal new shares itself. | Start/stop/restart/config actions execute through Talos API after explicit Operations drawer approval, and chain/backup operations use explicit signed or trusted-control-plane paths with auditable receipts. |
| RPC coverage | Some screens still depend on unexposed RPC methods and now render named blockers instead of fabricated values. Hardware/Monarch OS readiness now checks service state plus Protocore RPC serving state and reads Talos host telemetry for load average, memory, mounts, disk I/O, disk inventory, and network counters; SMART/NVMe health remains named as absent because the Talos API client surface does not expose it. Metrics now reads `lyth_metricsRange` for the canonical retained telemetry selectors (`committed_round`, `mempool_depth`, `execution_units_used_per_block`, `proposer_latency`, `attestation_rate`, `p2p_bandwidth_in`, `p2p_bandwidth_out`, `finality_lag`) and exports those rows with the basic chain snapshot. Home and Operator identity now resolve authority index and read `lyth_operatorRisk`, `lyth_signingActivity`, and `lyth_upcomingDuties` for removal-risk, recent signing, attestation, and key-rotation windows when the endpoint exposes them. Cluster now reads `lyth_getClusterResignations` for pending/applied operator resignation rows and resolves `lyth_getOperatorNetworkMetadata` for every visible cluster member instead of only the lead row. | Every screen either uses live SDK/RPC data or shows a named blocker tied to mono-core/SDK work. |
| Cluster model | The Home/Cluster/Operator surfaces now share a tested whitepaper topology helper: default active cluster `C-000`, target scale `100 clusters x 10 operator seats`, `7-of-10` threshold, and `7 active + 3 standby` seat framing. The Cluster view now flags live topology drift or below-threshold state instead of silently rendering a single-node assumption. | Cluster views represent clusters and operators directly, not historical single-node assumptions. |
| Terminology | The release workflow now runs `pnpm run check:release-terminology` before typecheck/tests. The checker ignores tests and local-only handover docs, but fails release surfaces if open implementation markers, fake/mock-facing runtime copy, or retired role labels return. | Signed releases use operator/cluster language. Internal ids should be migrated only when it does not break persisted state or external APIs. |
| Secure signing | Final operator approval/signing path is not complete. Operator-register, redelegate, chat peer publication, and DKG re-share attestation use the operator keychain mnemonic to submit signed native transactions; foundation-gated recovery and pending-change operations use the foundation operations mnemonic when present; OS upgrade/rollback use Talos mTLS with trusted CA pinning and explicit drawer approval. Tauri no longer turns a missing SSH session into simulated success, no longer falls back to SSH after Talos action failure, and blocked production paths emit hash-bound error receipts instead of pretending to execute. | Destructive actions require explicit approval, keychain/passkey/hardware-backed controls, and audit logs. |
| Release provenance | Desktop reads `lyth_runtimeProvenance` and fails closed when the live `runtime.binarySha256` differs from the stored expected digest. | Desktop shows signed build provenance, compares it to the running node, and blocks privileged operation on mismatch. |
| Packaging | Release workflow now fails tagged builds before packaging when required signing inputs are missing, requires the full macOS arm64/macOS x64/Linux x64/Windows x64 matrix to pass before publishing, signs/notarizes macOS, signs Windows through Azure Trusted Signing, emits Tauri updater signatures, generates `latest.json`, and runs `verify:release-artifacts` to reject missing installers, updater bundles, updater signatures, or platform entries. | Release builds are signed/notarized where required and include update-channel metadata. |
| Testing | The release workflow now runs TypeScript typecheck, Vitest, Rust tests, a deterministic release-readiness contract, an opt-in e2e recorder contract, and the e2e evidence verifier contract. The verifier rejects incomplete QEMU smoke evidence, browser/manual evidence, missing required GUI routes/commands, missing or malformed DKG re-share attestations, operation receipts without the Desktop audit schema/hash, incomplete chat/readiness evidence, missing chat sender membership proof, and release-digest evidence that is not bound to the Monarch OS release metadata. Rust chat tests cover address normalization for `0x` and `mono1...`, runtime sender membership proof through `lyth_clusterStatus` plus `lyth_operatorInfo`, local libp2p exchange, file-backed chat history persistence across reopen, persisted-record re-verification from signed-envelope fields, signature rejection, channel mismatch rejection, own-echo dedupe, unsubscribed-channel rejection, and Talos upgrade/rollback input restrictions. TypeScript SDK tests cover the register tx defaults, redelegate precompile target, recovery, pending-change, DKG re-share, and chat-bootstrap node-registry calldata/fee/submit paths, zero-value calldata, fee clamp, input validation, plaintext submit path, operator risk/signing telemetry view models, cluster resignation summaries, OS upgrade input validation, hash-bound operation receipts, assistant-proposed OS upgrade/rollback mapping, metrics-range formatting/summaries, DKG artifact import validation, and chat release-readiness rejection when persisted envelope fields are missing. A `tauri-driver` harness exists for route/command evidence, in-app Desktop readiness collection, DKG artifact inclusion, and artifact generation. When a peer mnemonic is supplied, the harness prepares the primary chat subscription, sends a signed peer message from the secondary window, waits for gossip propagation, resolves the active cluster roster through `lyth_clusterStatus` and `lyth_operatorInfo`, then collects final readiness from the primary window. `e2e:monarch` starts OS smoke with keepalive, runs Desktop e2e, and tears QEMU down; the `gui-e2e` workflow job downloads a Monarch OS raw release image plus release metadata and is now required before tagged release packaging. Chat bootstrap peers can now be explicit release inputs, published from the Operations drawer, or discovered from live node-registry chat metadata through `lyth_getOperatorNetworkMetadata`; the remaining operational gap is maintaining release-grade cluster id, DKG attestation, mnemonics, and declared live chat metadata for each release candidate. | CI or release validation boots a Monarch OS image, applies config, verifies `ext-protocore`, drives Desktop through the Tauri GUI, and stores the verified evidence artifact. |

## Build Plan

### Phase 1: Make The GUI Honest

- Label SSH as development-only for plain Linux hosts.
- Render unavailable data as named blockers, not local fixtures.
- Document every screen that is not fully live.
- Sweep released copy toward operator/cluster language.

Exit criteria:

- Operators can tell what is live, what is dev-only, and what is blocked.
- No production-looking screen renders fabricated chain, operator, cluster, log, or hardware data.

### Phase 2: Talos Credentials And Connection

- Rust commands parse and inspect `talosconfig`.
- The GUI can select a `talosconfig` through the native file dialog.
- Endpoint and config-path references are stored through the OS keychain.
- The GUI shows connection status, certificate fingerprints, and certificate expiry.
- The GUI can trust the current Talos CA fingerprint and blocks later mismatches.

Exit criteria:

- The app can establish a verified Talos API connection to a Monarch OS node.
- Certificate or endpoint mismatch blocks privileged actions.

### Phase 3: Talos Service And Logs

- Read `ext-protocore` service state through Talos API.
- Stream service logs through Talos API.
- Show running, restarting, waiting-for-config, syncing/RPC-pending, serving-RPC, degraded, stopped, and failed states distinctly.
- SSH-backed logs remain available only for plain Linux development hosts.

Exit criteria:

- The Logs and Home views can operate against Monarch OS without SSH.

### Phase 4: Approved Operations

- Map approved Operations drawer actions to Talos service/config calls.
- Require explicit confirmation before each privileged action.
- Persist local operation receipts with success/failure detail.
- Keep Ask Monarch advisory only; Ask Monarch may propose an action but never executes it.

Exit criteria:

- A node operator can safely restart or inspect `protocore` through Desktop with an auditable approval flow.

### Phase 5: Live Chain And Cluster Data

- Wire all available `@monolythium/core-sdk` methods.
- Replace named blockers as mono-core exposes chain, cluster, operator, signing, and indexer endpoints.
- Keep blocked mono-core requirements listed in the app docs until exposed.

Exit criteria:

- Production views are live against RPC/SDK, with absent data shown as explicit blockers.

### Phase 6: Signed Product Release

- Configure signed desktop builds for macOS, Windows, and Linux.
- Add update-channel metadata.
- Keep the GUI/Tauri release gate supplied with current live peer chat, cluster, and mnemonic inputs for each release candidate.
- Publish operator docs for install, connect, operate, upgrade, and recover.

Exit criteria:

- The app can be installed from a signed release and used against a signed Monarch OS artifact without local development tooling.

## Immediate Next Implementation Targets

1. Add the production ceremony runner for key-share output: DKG transition evidence, TPM-sealed output shares, and operator handoff artifacts. The Desktop/OS import contract now exists for the `attestDkgReshare` artifact, but Desktop still does not run DKG or seal new shares itself.
2. Keep GUI/Tauri e2e release validation supplied with current live peer chat, cluster, DKG attestation, and mnemonic inputs for each candidate.
3. Replace remaining named blockers as mono-core/SDK endpoints become available.
