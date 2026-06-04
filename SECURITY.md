# Security Policy

## Supported versions

Monarch Desktop is currently in **preview** (`v0.x.y`). The first non-preview tag will define the supported-versions window. Until then, only the latest commit on `master` is considered current.

## Reporting a vulnerability

If you believe you've found a vulnerability in Monarch Desktop — particularly anything that could:

- bypass the Operations drawer's `preview → auth → executing → done` flow,
- exfiltrate keychain-stored credentials (Hosted provider API key, SSH keys, Talos client certificates),
- forge or replay Talos API mTLS handshakes,
- escalate from the advisory bridge's "advisory only" boundary into an executed operation,
- leak host fingerprints, certificate material, or `talosconfig` contents through logs or events,
- bypass `protocore` release-digest attestation,

please **do not open a public issue or PR**.

Email `security@monolythium.com` with:

1. A clear description of the issue.
2. Reproduction steps (or a proof-of-concept) against the latest `master`.
3. The commit SHA you tested against.
4. Your assessment of impact and any suggested mitigation.

We aim to acknowledge within 3 business days and to publish a fix within 30 days for high-severity findings.

## Disclosure

Coordinated disclosure is required for any finding affecting a signed release. For preview-tag findings, we'll work with you on timing — typically a fix lands on `master` first, and the public disclosure follows once dependent ecosystem components (Monarch OS image, mono-core, mono-core-sdk) have absorbed any needed change.

## Out of scope

- Reports against builds older than the latest `master`.
- Reports requiring a malicious operator with workstation access — Monarch Desktop is an operator tool, not a multi-user product.
- Issues in upstream dependencies (Tauri, React, `talos-rust-client`, `russh`, etc.) — please report those upstream and we'll pick up the fix.
- Vulnerabilities in private Monolythium components (`mono-core`, `mono-core-sdk`, the operator-facing chain itself) — please use the contact above; we'll route internally.

## What we won't do

- Reward bug reports with bounties. Monarch Desktop is not enrolled in a bug-bounty program at this stage. Public acknowledgment in release notes is the recognition we can offer.
- Run automated scans against your environment. If you want a security review of your operator deployment, that's an engagement, not a vulnerability report.
