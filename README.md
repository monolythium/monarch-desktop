# monarch-desktop

> Operator console for [Monolythium](https://monolythium.com) — Tauri 2 + React 19 + a native Talos API mTLS client. Built for operators who log into a server at 3 am to find out why a node is unhealthy.

**License:** Apache-2.0 · **Status:** preview (testnet only) · **Stack:** Tauri 2 · Rust · React 19 · TypeScript · Vite

## Download

**[Preview builds — GitHub Releases →](https://github.com/monolythium/monarch-desktop/releases)** (operator console; macOS · Windows · Linux). Early, preview-grade builds pointed at testnet — the fully signed release channel is still pending. Or build from source (below).

---

## Status: preview

Functional shell with substantive backend, but not yet production-grade. Set expectations before adopting:

- **Chain target is testnet.** Monolythium mainnet has not launched. Anything you connect to here runs against the public testnet today; mainnet activation is gated on separate protocol milestones.
- **SDK is consumed straight from npm.** `package.json` pins `@monolythium/core-sdk` to the exact published version `0.4.1` ([`monolythium/mono-core-sdk`](https://github.com/monolythium/mono-core-sdk)). `pnpm install` resolves it from the registry; no sibling checkout is required.
- **Production-looking fixtures were removed.** Views now use live RPC/Talos reads or render named blockers for missing `mono-core` endpoints. The readiness gap list in [`docs/final-product-readiness.md`](./docs/final-product-readiness.md) enumerates which screens are live vs blocked.
- **Operator-targets are not bundled.** The Logs view dropdown is empty by default. To populate it locally, copy [`examples/operators.json.example`](./examples/operators.json.example) to `examples/operators.json` (gitignored) and edit — an in-app loader that reads this on launch is a later milestone.
- **Signed-release pipeline exists, but no artifacts are published yet.** `.github/workflows/release.yml` defines a four-platform build matrix (macOS arm64/x64, Linux x64, Windows x64) with Azure Trusted Signing for Windows. No tagged release has run it end-to-end.

Watch this repo for the first non-preview tag before treating any build as production-grade.

---

## What this is

Monarch Desktop is the workstation GUI operators use to control [Monolythium](https://monolythium.com) nodes and clusters. It runs natively on macOS, Linux, and Windows, and it talks to nodes through two intentionally distinct channels:

- **Talos API mTLS** on TCP `50000` — the control plane for Monarch OS nodes (which expose no SSH and no traditional userspace). Implemented as a native Rust client in `src-tauri/src/talos.rs` that parses `talosconfig`, verifies CA + client-certificate fingerprints and expiry horizons, drives service actions, and streams logs.
- **Protocore JSON-RPC** on TCP `8545` — the data plane. SDK hooks in `src/sdk/` consume `@monolythium/core-sdk` to read chain state.

An **SSH bridge** in `src-tauri/src/ssh.rs` (via [`russh`](https://github.com/Eugeny/russh)) exists for plain-Linux development hosts only — Monarch OS production paths do not use SSH.

Every privileged action — start / stop / restart / config / signing — routes through the **Operations drawer** (`src/ops/`). The drawer's state machine (`preview → auth → executing → done`) is the audit boundary. Talos service actions use the native mTLS bridge; operator-register and redelegate use signed native transactions from the operator keychain mnemonic. Ask Monarch is advisory only: the **Ask Monarch** bridge (`src-tauri/src/ai.rs`) supports Hosted (Hosted provider Messages API) or local Local, parses `proposed_action` envelopes from model output, and hands them to the drawer at the `preview` stage. The model never executes anything directly.

## Who this is for

Node operators, tier-1 exchange operations staff, and Monolythium Foundation operators running clusters. If you have ever opened a terminal at night to check why a node is unhealthy, this app is for you.

## Prerequisites

To inspect, audit, or develop:

- **Node** 22+
- **pnpm** 10+ (`corepack enable && corepack prepare pnpm@10 --activate`)
- **Rust** 1.77+
- Tauri 2 platform prerequisites — see <https://v2.tauri.app/start/prerequisites/>

`pnpm install` resolves all dependencies from npm, including `@monolythium/core-sdk@0.4.1` ([`monolythium/mono-core-sdk`](https://github.com/monolythium/mono-core-sdk)). No sibling checkout is required.

## Quick start

For external readers — the most useful actions today are auditing the source and reading the readiness docs:

```bash
git clone https://github.com/monolythium/monarch-desktop.git
cd monarch-desktop

# Read the native Talos client (control plane)
less src-tauri/src/talos.rs

# Read the advisory bridge (advisory-only Ask Monarch)
less src-tauri/src/ai.rs

# Read the Operations drawer state machine (audit boundary)
less src/ops/OperationsDrawer.tsx
less src/ops/proposedAction.ts

# Read the readiness gap list
less docs/final-product-readiness.md
```

With dependencies installed:

```bash
pnpm install
pnpm run check:release-terminology              # no open markers or fake-facing copy
pnpm typecheck                                    # tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml  # Rust side
pnpm test                                         # vitest run
pnpm run test:release-readiness                   # Desktop release gate subset
pnpm run verify:e2e-evidence -- ./evidence.json   # verify a GUI/Tauri evidence artifact
pnpm run e2e:tauri -- --os-smoke ../monarch-os-talos/_out/smoke-qemu/result.json \
  --talos-endpoint https://127.0.0.1:50000 \
  --talos-config ../monarch-os-talos/_out/smoke-qemu-config/talosconfig \
  --trust-talos-config                           # drive Tauri via tauri-driver
pnpm run e2e:monarch -- --build-app              # boot OS smoke, drive Desktop, stop QEMU

# Browser-only preview (no Talos / SSH / keychain bridges)
pnpm dev

# Native Tauri shell (full backend)
pnpm tauri dev
```

To populate the Logs view's operator-targets dropdown for local use:

```bash
cp examples/operators.json.example examples/operators.json
# Edit examples/operators.json with your real hosts. This file is gitignored.
```

## Repo layout

```
monarch-desktop/
├── src/                          # React 19 + TypeScript frontend
│   ├── App.tsx, main.tsx
│   ├── views/                    # Home, Cluster, Operator, Operations,
│   │                             # Metrics, Hardware, Logs, Install
│   ├── components/               # ClusterRing, AiSettings, SshSettings,
│   │                             # TalosSettings, TopBar, SideNav,
│   │                             # AskBar, AskRail, TweaksPanel,
│   │                             # SigningStrip, Sparkline
│   ├── ops/                      # Operations drawer + proposed-action engine
│   │   ├── OperationsDrawer.tsx
│   │   ├── OpsContext.tsx
│   │   ├── catalog.ts            # Command kinds + display metadata
│   │   ├── proposedAction.ts     # assistant-emitted action → drawer input
│   │   └── proposedAction.test.ts
│   ├── sdk/                      # Tauri bridge + chain RPC hooks
│   │   ├── bridge.ts             # invoke() wrappers per command surface
│   │   ├── client.ts             # @monolythium/core-sdk client setup
│   │   ├── useNodeStatus.ts      # Live node status hook
│   │   ├── useLogStream.ts       # Talos + SSH log streaming
│   │   ├── mrvReadiness.ts       # MRV no-EVM readiness metric
│   │   ├── releaseAttestation.ts # Protocore release-digest comparison
│   │   ├── releaseReadiness.ts   # Desktop release-readiness gate
│   │   ├── releaseE2eEvidence.ts # Required GUI/Tauri e2e evidence shape
│   │   ├── e2eRecorder.ts        # Opt-in route/command evidence recorder
│   │   └── networkDiagnostics.ts
│   ├── nav/                      # Routing + g+letter keybinds
│   ├── palette/CommandPalette.tsx
│   └── styles/global.css
├── src-tauri/                    # Rust backend
│   └── src/
│       ├── main.rs, lib.rs
│       ├── talos.rs              # Native Talos API mTLS client
│       ├── ssh.rs                # russh dev-host bridge
│       ├── keychain.rs           # OS keychain (Hosted provider key, SSH,
│       │                         # talosconfig path, protocore digest)
│       └── ai.rs                 # Hosted / Local bridge for Ask Monarch
├── docs/
│   └── final-product-readiness.md
├── examples/
│   └── operators.json.example    # Shape for the local-only operators.json
└── .github/workflows/release.yml # 4-platform build + signing pipeline
```

## Advisory integration (Ask Monarch)

The Ask Monarch bar is a streaming advisory assistant for operator workflows. It supports two providers, settable from `Settings → advisory bridge`:

- **Hosted** via the Hosted provider Messages API (configurable model). The API key is stored in the OS keychain (`hosted-provider-api-key`) and read on each request — the React side never holds the cleartext key past the Settings input handler.
- **Local**, default URL `http://localhost:11434`, default model `qwen2.5:3b`. Both URL and model are operator-configurable.

The bridge is **advisory only.** It parses a `<proposed_action>{...}</proposed_action>` JSON envelope out of the model's text and hands it to the React side, which opens the Operations drawer at the `preview` stage. The drawer's state machine (`preview → auth → executing → done`) is the only path that ever touches the host. The Ask Monarch never executes anything.

Ask Monarch does not ship canned operational answers. Outside Tauri, without a configured provider, or when the provider errors, the rail shows the error state and no suggested action instead of fabricating missed rounds, risk scores, duties, or restart advice.

## Documentation

- [`docs/final-product-readiness.md`](./docs/final-product-readiness.md) — comprehensive gap list across the operator surface (operations execution, RPC coverage, cluster model, terminology sweep, secure signing, release provenance, packaging, testing) followed by a phased build plan.
- [Monarch OS connectivity](https://github.com/monolythium/monarch-os-talos/blob/master/docs/monarch-desktop-connectivity.md) — node-side provisioning flow + how this desktop connects to a Monarch OS node.

## Release pipeline status

`.github/workflows/release.yml` defines the signed-release shape:

- 4-platform build matrix: macOS arm64, macOS x64, Linux x64, Windows x64.
- Release readiness checks run before packaging: `pnpm run check:release-terminology`, `pnpm typecheck`, `pnpm run test:release-readiness`, `pnpm test`, and `cargo test --manifest-path src-tauri/Cargo.toml --locked`.
- Manual dispatch can verify a checked-out `monarch-desktop-e2e-evidence/v1` JSON file through the `desktop_e2e_evidence` input before packaging.
- Tagged releases and manual dispatches with a release `tag` must pass the Linux `gui-e2e` job before packaging. The job checks out `monarch-os-talos`, downloads a signed raw image and release metadata from a Monarch OS release, derives the expected Protocore digest from `sources.protocore_binary.sha256`, boots configured QEMU smoke, runs the Desktop Tauri harness, and uploads `monarch-desktop-e2e-evidence/v1`. Non-release manual dry runs can also run it with `run_desktop_e2e=true`. The job requires primary and peer secrets (`MONARCH_E2E_OPERATOR_MNEMONIC`, `MONARCH_E2E_PEER_OPERATOR_MNEMONIC`), cluster id, and a `monarch-dkg-reshare-attestation/v1` JSON artifact supplied through the `desktop_e2e_dkg_reshare_attestation` input or `MONARCH_E2E_DKG_RESHARE_ATTESTATION` var/secret; chat bootstrap peers can be supplied explicitly or discovered from live `lyth_getOperatorNetworkMetadata` chat metadata declared through node-registry.
- Tauri build per target, with platform-specific bundle outputs (dmg / app.tar.gz / deb / AppImage / msi / exe).
- Tagged release builds fail before packaging when required signing inputs are missing, and the publish job only runs after the complete build matrix succeeds.
- `pnpm run verify:release-artifacts -- <artifact-dir> --tag <tag>` verifies macOS/Linux/Windows installers, updater bundles, updater signatures, and `latest.json` platform entries before upload.
- Windows artifacts signed via [Azure Trusted Signing](https://azure.microsoft.com/en-us/products/trusted-signing) using GitHub `secrets.AZURE_*` references.
- Artifacts uploaded per platform and attached to a published GitHub Release.

### Tag convention

A signed, notarized production release is cut by pushing a **non-preview** semver tag — `v<version>` with no suffix, e.g. `v0.0.6` (the tag version must equal `tauri.conf.json > version`). That tag runs the full four-platform signed matrix and publishes a `Latest`, non-prerelease GitHub Release.

`*-preview` tags (e.g. `v0.0.6-preview`) are **excluded from the auto-publish trigger** and never publish a "Latest" release, matching the [status note above](#status-preview) that operators should wait for "the first non-preview tag" before trusting a build. For a preview or dry-run build, use the manual `workflow_dispatch` instead: leave the `tag` input empty for a build-only dry run, or set it to a preview tag to attach preview artifacts deliberately.

The release-readiness test subset now requires Talos identity pinning, healthy
Protocore RPC readiness, release-digest attestation, Talos operation receipts,
verified two-party chat evidence with sender membership proof, an opt-in `VITE_MONARCH_E2E_RECORDER=true`
route/command recorder, and a `monarch-desktop-e2e-evidence/v1` verifier
contract. The verifier requires QEMU smoke proof, two observed Tauri windows,
`/home`/`/hardware`/`/operations`/`/chat` route coverage, required Tauri
commands, and a passing release-readiness report. Runtime chat join, send,
persisted subscription restore, and inbound peer persistence also resolve
`lyth_clusterStatus` plus `lyth_operatorInfo.chainAddress` before accepting
a signed sender into a cluster channel. `pnpm run e2e:tauri` now
drives a recorder-enabled Tauri build through `tauri-driver`, clicks the real
navigation links, can bootstrap Talos/keychain settings in-app, collects
Desktop readiness unless an external JSON is supplied, merges the recorder
output with QEMU smoke, and verifies the generated evidence. `pnpm run
e2e:monarch` wraps the whole local lifecycle: generate smoke config, run
`KEEP_QEMU_ALIVE=true make smoke-qemu-artifact`, source the generated live env,
run the Desktop harness, and stop QEMU. When OS release metadata is present,
the smoke live env supplies the expected Protocore digest to Desktop from
`sources.protocore_binary.sha256`. Tagged release packaging now depends on that
GUI e2e gate; the operational requirement is keeping the release secrets,
cluster id, DKG attestation, and live operator chat metadata current for each
candidate.
When two windows are available, the harness first subscribes the primary chat
identity, sends a peer message from the secondary identity, waits briefly for
gossip propagation, then collects final readiness from the primary window.

Tauri WebDriver prerequisites follow the official Tauri model: install
`tauri-driver` with `cargo install tauri-driver --locked`; on Linux install
`WebKitWebDriver`/`webkit2gtk-driver` and run under `xvfb`; on Windows ensure
Edge WebDriver matches the installed Edge version.

## Related projects

- [**monolythium.com**](https://monolythium.com) — protocol home, whitepaper, ecosystem links.
- [**`monolythium/monarch-os-talos`**](https://github.com/monolythium/monarch-os-talos) — public Talos-based immutable node OS that this desktop console is designed to operate.
- [**`monolythium/mono-core-sdk`**](https://github.com/monolythium/mono-core-sdk) — public TypeScript + Rust SDK consumed here as `@monolythium/core-sdk`.
- [**`monolythium/mono-studio`**](https://github.com/monolythium/mono-studio) — public developer toolchain for MRV contracts and MRC assets.
- [**`monolythium/monoscan`**](https://github.com/monolythium/monoscan) — public block explorer.
- [**`monolythium/lyth_mcp`**](https://github.com/monolythium/lyth_mcp) — public MCP server for the broader ecosystem.
- **`monolythium/mono-core`** *(private)* — the chain itself; source of the `protocore` binary the operator nodes run.
- **`monolythium/desktop-wallet`** *(private)* — the Monolythium wallet (consumer/trader app, distinct from this operator console).

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Short version: run the three gates (`pnpm typecheck`, `cargo check`, `pnpm test`) locally before opening a PR — there is no public CI workflow that runs them today.

## Security

See [`SECURITY.md`](./SECURITY.md). Short version: vulnerability reports to `security@monolythium.com`, **not** the public issue tracker.

## License

Released under the Apache License, Version 2.0. See [`LICENSE`](./LICENSE) for the full text.
