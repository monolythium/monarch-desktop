# Contributing to Monarch Desktop

Thanks for considering a contribution. Monarch Desktop is in **preview** — the operator surface, the Talos client, and the AI bridge are all still moving — so the most useful contributions today are bug reports, doc fixes, focused PRs against existing modules, and feedback on the Operations drawer approval model.

## Before opening a pull request

Run all three gates locally — there is no public CI workflow that exercises them today, so the burden is on you:

```bash
pnpm install
pnpm typecheck                                    # tsc --noEmit
cargo check --manifest-path src-tauri/Cargo.toml  # Rust side
pnpm test                                         # vitest run
```

Keep all three green before opening the PR.

## What we're looking for

- **Bug fixes** in `src/`, `src-tauri/src/`, or `src/sdk/` — welcome any time.
- **Doc fixes** in `README.md`, `CONTRIBUTING.md`, or `docs/` — welcome any time.
- **New SDK hooks** in `src/sdk/` that wrap additional `@monolythium/core-sdk` methods as they become available — please link the matching readiness entry from [`docs/final-product-readiness.md`](./docs/final-product-readiness.md) in your PR.
- **Operations drawer commands** under `src/ops/` — adding a new command kind means updating `src/ops/types.ts`, `src/ops/catalog.ts`, `src/ops/proposedAction.ts`, and the matching unit test. The drawer's `preview → auth → executing → done` state machine is intentional; don't bypass it.
- **Talos client improvements** in `src-tauri/src/talos.rs` — please cover behavior with unit tests in the same file.

## What we'll likely push back on

- **Direct destructive Tauri commands that skip the Operations drawer.** Every privileged action goes through `OpsContext` → drawer preview → explicit auth → execute. The drawer is the audit boundary; bypassing it loses that boundary.
- **AI calls that submit actions directly.** The AI bridge is advisory only — it parses a `proposed_action` envelope from model output and hands it to the drawer at the `preview` stage. The drawer is the only path that ever touches the host. Don't add a code path where the model executes anything.
- **Adding the four real testnet validator hosts back into `TESTNET_TARGETS`.** That list is intentionally empty in the published source. Operators populate it from `examples/operators.json` locally (gitignored). See `src/sdk/useLogStream.ts` for the JSDoc on the contract.
- **Hardcoding real production IPs / hostnames / SSH key paths anywhere in source.** The `192.0.2.0/24` block (IETF TEST-NET-1) and `example.com` are the convention for documentation and tests.

## Commit + PR conventions

- Plain English in the imperative ("Add foo", "Fix bar") — no emoji, no `:phase:` or colon-prefixes.
- One logical change per commit when practical. Squash before merge if a PR grew several commits during review.
- Reference the relevant doc or readiness entry in the PR description.

## Security

If you've found a vulnerability, please **do not open a public issue**. Email `security@monolythium.com` and we'll coordinate disclosure. See [`SECURITY.md`](./SECURITY.md) for the full disclosure policy.

## Code of conduct

Be respectful. Disagree on technical merit. Don't be a jerk.
