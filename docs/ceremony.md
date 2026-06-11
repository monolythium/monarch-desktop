# The Ceremony Room — forming a cluster

The Ceremony Room is Monarch Desktop's live lobby for forming a new Monolythium **cluster**: ten registered **operators** meet on a signed chat channel, claim seats (7 active + 3 standby, 7-of-10 threshold), see the exact terms they are signing, publish ML-DSA-65 consent signatures over one shared digest, and hand the assembled roster to the Operations drawer for the single `formCluster` submit.

Three properties drive everything below:

- **Identity is the verified envelope, never a claim.** Every lobby message travels as a signed chat envelope; your identity in the ceremony is the envelope's sender key — which is the same key as your registered consensus key. Nothing in a message body can impersonate a seat.
- **Lobby state is a pure fold over the channel's messages.** Every client independently reduces the same signed messages to the same roster, digest, and readiness. There is no server.
- **The consent digest binds the exact configuration.** It is recomputed locally by every client from the claimed roster. Any change — a different claimant, a different seat order — produces a different digest, which automatically voids every consent collected so far.

---

## Prerequisites — every participant

Each of the ten members must, before joining a ceremony:

1. **Be a registered operator** with the 5,000 LYTH self-bond locked. The ceremony transport refuses senders who are not registered, and each claimed seat is live-probed on-chain — a seat showing **NOT bonded** will fail `formCluster` at submit.
2. **Have published their seal key** (the node's ML-KEM encapsulation key) — required for sealed-mempool duty in any cluster.
3. **Have published their chat bootstrap peers** (Operations → Chat bootstrap peers) — without published multiaddrs the lobby cannot mesh with you.
4. **Have their PQM-1 operator key stored** in the OS keychain on the workstation running Desktop (Keys page) — it signs both your chat envelopes and your consent.

These are steps 5, 7, and 8 of the welcome checklist; the checklist links here from step 9.

## Create or join a ceremony

- **Start new ceremony** generates a random ceremony id (lowercase hex). Share that id with the other nine operators out-of-band (operator chat, a call — anywhere).
- **Join lobby** with an id someone shared. Anyone with the id and a registered operator key can enter the lobby; entering grants nothing — only claiming a seat and signing does.
- An optional display name labels you in the lobby; it has no protocol meaning.

If the lobby doesn't mesh (you see no messages from peers you know are in), use **Dial lobby peers**: paste their libp2p multiaddrs one per line and dial directly. Operators forming a cluster don't share an existing cluster channel, so meshing depends on the published chat-peer records plus manual dials.

## The proposal

One operator — the **initiator** — publishes the proposal. **The first valid proposal wins** and pins, for everyone:

- **The 10 seats**: 7 active + 3 standby. Each seat may optionally be **pinned** to a specific operator id (pin all ten or none); unpinned seats are open to any registered operator in the lobby.
- **The terms** (see the charter table below).
- **The expiry**: a countdown after which the lobby refuses to submit and a fresh ceremony must be proposed.

## Seats and roles

- **Active seats (7)** sign consensus from day one. Only an active-seat member can later submit the `formCluster` transaction.
- **Standby seats (3)** are full cluster members who step in when an active operator rotates out or fails.

Claim a seat from its card. The lobby enforces, per claim: the claimant's envelope key must derive their sender address, the seat must not already be claimed, and a pinned seat only accepts its pinned operator id. Your own seat is badged **YOU**. Each claimed seat also shows a live chain probe — *bonded / lifecycle state* — so the lobby surfaces a doomed roster before anyone signs.

## The charter — the economic terms you sign

| Term | Meaning | Default | Bounds |
|---|---|---|---|
| `member_share_bps[10]` | Each member's share of the cluster's **operator-side** reward pot, in basis points, in roster order (active 1–7, then standby 1–3). | Equal split — 1,000 bps (10%) each | The ten values must sum to exactly 10,000 |
| `delegator_share_bps` | The share of the cluster's reward pot that goes to the cluster's **delegators** before the operator-side split. | 5,000 bps (50%) | **Protocol floor: 2,000 bps (20%)** — a charter cannot starve delegators below it; ceiling 10,000 |
| `expires_ms` | Consent expiry (unix ms). A consent signature is only executable while the chain's block time is at or before this instant. | Set by the initiator | Must be in the future at submit |
| Bond | Self-bond per member, displayed for confirmation. | 5,000 LYTH | Protocol minimum |
| Threshold / topology | 7-of-10, 7 active + 3 standby. | Fixed | Not negotiable in this release |

**What makes the charter trustworthy:** with `formCluster` V2 (protocore `v0.1.47-testnet` and later), the charter bytes and the consent expiry are folded **into the signed consent digest**. You sign the exact member shares, the exact delegator share, and the exact expiry — and so does everyone else. A signature over one charter cannot be replayed under different terms; **nobody can be bound to terms they did not sign.** Clusters formed without a charter (the 3-argument `formCluster`) get the protocol defaults: equal member split, 50% delegator share.

> **Current Desktop build:** the Ceremony Room supports both paths. The proposal form carries a charter editor (per-seat shares with a live sum check, a delegator-share slider bounded by the protocol floor, and a consent-expiry picker, default now+48h); with a charter the lobby runs the charter-committing V2 digest end-to-end (sign, verify, export/import, submit) and the terms panel renders the exact charter every member signs. Unchecking the charter falls back to the V1 digest and the protocol-default economics, with the proposal-envelope caveat shown in the app.

## Freeze and sign

1. **The digest appears when all ten seats are claimed.** Every client recomputes it locally from the claimed roster in canonical order (active 0–6, then standby 0–2 — the order is consensus-critical).
2. **The initiator freezes the digest**, pinning it for the lobby. Freezing is a coordination convenience, not an authority grant: every client keeps recomputing locally, and if the frozen digest differs from a client's local recomputation, that client shows **digest mismatch** and refuses to sign or submit. A mismatch means the clients do not all see the same roster — stop and resolve it (see troubleshooting).
3. **Compare the digest out-of-band.** The app renders it in 4-character groups precisely so you can read it to the other operators over a call before signing.
4. **Sign consent.** Signing happens in the Rust backend: it re-derives the digest from the roster itself and signs with your keychain identity. There is deliberately **no "sign this digest" surface** — the app will never sign a digest it did not recompute, and the client additionally refuses to publish if the signer's digest differs from its own. Your consent (the ML-DSA-65 signature) is then published to the lobby.
5. **Delivery is best-effort.** Publishes ride gossip with no acknowledgment; the lobby shows your consent as published locally, and a **Re-send consent** button covers the case where peers report it missing.

Readiness is exactly: **all ten seats claimed, ten distinct verified consents over the current local digest, no mismatch, not expired.** A consent over an older digest shows as *stale*; an unverifiable one shows as *invalid* — both block readiness.

## Walking away

**Before submit, walking away is always safe.** The **Walk away** button (with a confirm step) frees your seat and deletes your consent from the lobby. The moment anyone else claims your seat, the digest changes and **every** collected consent goes stale — the room cannot submit a roster you left.

Two honest caveats, exactly as the app states them:

- A consent signature is a **bearer artifact**. If the identical ten-member roster re-forms — same people, same seats — a copy of your old signature would still verify against the recomputed digest. Walk-away is social, not cryptographic, against a byte-identical re-formation. The proposal **expiry** bounds this window; with charter V2 the expiry sits inside the signed digest and the chain itself rejects execution after it, closing the gap at the protocol level.
- **After submit, the cluster exists on-chain.** Walking away in the lobby changes nothing — your signature is part of the executed transaction. Leaving a live cluster is a protocol action: use the **resign** verb (`cluster-resign`) in the Operations drawer, which schedules your exit and releases your bond after the protocol delay.

## Submit

When the room shows ready, **an active-seat member** presses *Review & submit in Operations drawer*. The chain enforces this — `formCluster` from any sender who is not an active roster member is rejected — so if you hold a standby seat, ask one of the seven active operators to submit (or hand them the JSON export, below).

Submitting does not bypass anything: it opens the standard Operations drawer at *preview*, runs the `lyth_previewFormCluster` preflight against the node, and only then asks you to authorize and sign the transaction with your operator key. One transaction forms the cluster; the other nine members do nothing further.

## What happens next

- The `formCluster` transaction executes and the cluster is recorded on-chain with its roster (and, under V2, its charter).
- The lobby shows *submitted* with the transaction hash; further submit attempts are refused.
- **The new cluster's seat activates after a notice period, measured in epochs** — the cluster does not begin signing consensus the moment the transaction lands. Watch your seat state on the Cluster page; once the notice period elapses, the cluster joins the committee and your checklist step 9 flips to done.

## Offline fallback — JSON export / import

When the lobby cannot mesh, the ceremony degrades to file hand-off without losing any verification:

- **Export ready ceremony** serializes a *ready* lobby (10 verified consents) as canonical JSON with an integrity hash: the ceremony id, the consent digest, the terms, every seat (role, index, operator id, pubkey, address), and every consent signature.
- **Import** on another machine validates everything **before** offering anything: schema and integrity hash, exactly 7 + 3 seats, recomputation of the consent digest from the imported roster, and ML-DSA-65 verification of all ten signatures against that digest. Any failure rejects the import with the reason.
- A validated import prefills the standard cluster-form input, and **Submit imported roster** is enabled only if your own operator key holds an *active* seat in the imported roster — the chain would reject anyone else.

The export is byte-compatible with the manual cluster-form paste boxes in the Operations drawer, so the fallback path and the lobby path converge on the same preview → authorize submit.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| *"Ceremony transport is unavailable in this build"* | You're in the browser preview (`pnpm dev`), or the desktop backend predates the ceremony commands. | Use the installed desktop app (v0.0.13+). If the lobby still can't be reached, coordinate over the JSON export/import fallback — it needs no live transport. |
| *"Operator PQM-1 key is not stored yet"* | No operator mnemonic in the OS keychain. | Keys page → create or import your 24-word PQM-1 mnemonic (welcome checklist step 3), then rejoin. |
| You can't send, or peers never see you | You are not a registered operator — the transport gate fails closed — or your chat peers aren't published. | Register (checklist step 5) and publish chat bootstrap peers (step 8). For meshing, exchange multiaddrs and use **Dial lobby peers**. |
| Seat card shows **NOT bonded** | That operator registered but the self-bond isn't locked (or lapsed). | That member must fund and lock the 5,000 LYTH bond before anyone signs — the chain will reject the formation otherwise. |
| **Digest mismatch** banner | The frozen digest differs from your local recomputation: the clients do not all see the same roster (usually a missed join/withdraw on someone's side). | Do not sign, do not submit. Initiator: **Re-broadcast snapshot**. Everyone: compare the digest groups out-of-band; once all clients agree, re-freeze and re-sign. |
| Late joiner sees an empty lobby | Gossip has no backfill — subscribers only see messages sent while subscribed. | The initiator presses **Re-broadcast snapshot**; the snapshot replays the proposal, joins, consents, freeze, and submit state for late joiners. |
| Your consent never shows up for peers | Publishes are fire-and-forget gossip. | Press **Re-send consent**. Your stored signature is re-published unchanged. |
| *"This ceremony has expired"* | The proposal's expiry elapsed before submit. | Expiry is not extendable — start a fresh ceremony. Collected signatures from the expired lobby are not reused. |
| Submit button refuses with *"only an ACTIVE roster member may submit"* | You hold a standby seat (or no seat). | Ask one of the seven active-seat operators to submit, or hand them the JSON export. |

## Related

- [Operator setup guide](https://github.com/monolythium/monarch-os-talos/blob/master/docs/operator-setup.md) — the full path from blank machine to this room.
- `formCluster` preview / preflight: `lyth_previewFormCluster` (see the SDK's node-registry surface in [`mono-core-sdk`](https://github.com/monolythium/mono-core-sdk)).
- Joining an existing cluster instead: *request-cluster-join* → members vote *vote-cluster-admit* (2f+1) — both in the Operations drawer.
