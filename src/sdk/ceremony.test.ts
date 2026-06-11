// Ceremony room reducer/schema/export tests.
//
// These run REAL ML-DSA-65 fixtures (MlDsa65Backend.fromSeed) so the
// consent-signature verification path is exercised end-to-end: the
// reducer's readiness gate, the withdraw-invalidation rule, the
// snapshot late-join path, the freeze digest-mismatch refusal, and the
// export/import roundtrip all hinge on genuine signature checks.

import { describe, expect, it } from "vitest";
import { formClusterMessageV2Hex } from "@monolythium/core-sdk";
import { MlDsa65Backend, mlDsa65AddressFromPublicKey } from "@monolythium/core-sdk/crypto";
import type { ChatMessage } from "./chat";
import { encodeClusterCharterHex, formClusterConsentMessageHex } from "./clusterFormOps";
import { operatorPubkeyHash } from "./operatorKeys";
import {
  CEREMONY_SCHEMA_VERSION,
  CEREMONY_SENTINEL_CLUSTER_ID,
  CeremonyTransportUnavailableError,
  buildCeremonySnapshotBody,
  buildClusterFormInput,
  buildClusterFormOpRequest,
  canSubmitCeremony,
  ceremonyCharterHashHex,
  ceremonyChannelId,
  ceremonyExportHash,
  ceremonyRoster,
  computeCeremonyConsentDigestHex,
  exportCeremonyJson,
  importCeremonyJson,
  parseCeremonyBody,
  reduceCeremony,
  sendCeremonyBody,
  subscribeCeremonyChannel,
  verifyCeremonyConsentSignature,
  type CeremonyExportFile,
  type CeremonyProposeBody,
  type CeremonySeatDecl,
  type CeremonyTerms,
} from "./ceremony";

// ---- fixtures ---------------------------------------------------------

const CID = "abcd1234deadbeef";
const CHANNEL_ID = ceremonyChannelId(CID);
const EXPIRES_MS = 4_000_000_000_000; // far future

function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/iu, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

type FixtureOperator = {
  backend: MlDsa65Backend;
  pubkeyHex: string;
  address: string;
  operatorIdHex: string;
};

function makeOperator(seedByte: number): FixtureOperator {
  const backend = MlDsa65Backend.fromSeed(new Uint8Array(32).fill(seedByte));
  const pubkey = backend.publicKey();
  const rawAddress = mlDsa65AddressFromPublicKey(pubkey);
  const address = rawAddress.startsWith("0x") ? rawAddress : `0x${rawAddress}`;
  return {
    backend,
    pubkeyHex: toHex(pubkey),
    address: address.toLowerCase(),
    operatorIdHex: toHex(operatorPubkeyHash(pubkey)),
  };
}

// 10 roster operators + 1 spare for the withdraw/replace scenario.
const OPS: FixtureOperator[] = Array.from({ length: 11 }, (_, i) => makeOperator(i + 1));

function openSeats(): CeremonySeatDecl[] {
  const seats: CeremonySeatDecl[] = [];
  for (let i = 0; i < 7; i += 1) seats.push({ role: "active", index: i, operator_id: "" });
  for (let i = 0; i < 3; i += 1) seats.push({ role: "standby", index: i, operator_id: "" });
  return seats;
}

function pinnedSeats(): CeremonySeatDecl[] {
  return openSeats().map((seat, i) => ({
    ...seat,
    operator_id: OPS[i]?.operatorIdHex ?? "",
  }));
}

function makeTerms(charterHex?: string): CeremonyTerms {
  return {
    threshold: 7,
    bond_lythoshi: "5000000000000",
    commission_bps: 500,
    ...(charterHex ? { charter: charterHex } : {}),
    charter_hash: charterHex ? ceremonyCharterHashHex(charterHex) : "",
  };
}

function proposeBody(
  seats: CeremonySeatDecl[] = openSeats(),
  charterHex?: string,
): CeremonyProposeBody {
  return {
    v: CEREMONY_SCHEMA_VERSION,
    t: "propose",
    cid: CID,
    seats,
    terms: makeTerms(charterHex),
    expires_ms: EXPIRES_MS,
  };
}

type MsgFactory = (args: { sender: FixtureOperator; body: unknown; id?: string }) => ChatMessage;

function makeMsgFactory(): MsgFactory {
  let seq = 0;
  return ({ sender, body, id }) => {
    seq += 1;
    return {
      msg_id: id ?? `m${String(seq).padStart(4, "0")}`,
      channel_id: CHANNEL_ID,
      cluster_id: CEREMONY_SENTINEL_CLUSTER_ID,
      sender_address: sender.address,
      sender_pubkey_hex: sender.pubkeyHex,
      body: JSON.stringify(body),
      timestamp_ms: seq * 1_000,
      nonce_hex: "0x00",
      signature_hex: "0x00",
      verified: true,
      from_me: false,
    };
  };
}

function rosterDigest(operators: FixtureOperator[], charterHex?: string): string {
  return computeCeremonyConsentDigestHex({
    activePubkeysHex: operators.slice(0, 7).map((op) => op.pubkeyHex),
    standbyPubkeysHex: operators.slice(7, 10).map((op) => op.pubkeyHex),
    charterHex,
  });
}

function signDigest(op: FixtureOperator, digestHex: string): string {
  return toHex(op.backend.sign(hexToBytes(digestHex)));
}

const PROPOSE_ID = "m0001";

/** propose + 10 joins + freeze + 10 consents — a fully ready ceremony.
 *  With `charterHex` the propose carries the charter and every consent
 *  is signed over the charter-committing V2 digest. */
function fullCeremonyMessages(
  roster: FixtureOperator[] = OPS.slice(0, 10),
  charterHex?: string,
): {
  msgs: ChatMessage[];
  msg: MsgFactory;
  digest: string;
} {
  const msg = makeMsgFactory();
  const initiator = roster[0]!;
  const msgs: ChatMessage[] = [
    msg({ sender: initiator, body: proposeBody(openSeats(), charterHex), id: PROPOSE_ID }),
  ];
  roster.forEach((op, i) => {
    const seat = i < 7 ? { role: "active" as const, index: i } : { role: "standby" as const, index: i - 7 };
    msgs.push(msg({ sender: op, body: { t: "join", cid: CID, ref: PROPOSE_ID, seat } }));
  });
  const digest = rosterDigest(roster, charterHex);
  msgs.push(
    msg({ sender: initiator, body: { t: "freeze", cid: CID, ref: PROPOSE_ID, consent_digest: digest } }),
  );
  for (const op of roster) {
    msgs.push(
      msg({
        sender: op,
        body: {
          t: "consent",
          cid: CID,
          ref: PROPOSE_ID,
          consent_digest: digest,
          sig: signDigest(op, digest),
        },
      }),
    );
  }
  return { msgs, msg, digest };
}

// ---- tests ------------------------------------------------------------

describe("ceremony reducer — roster assembly and readiness", () => {
  it("folds propose/join/freeze/consent into a ready lobby with a verified digest", () => {
    const { msgs, digest } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);

    expect(state.cid).toBe(CID);
    expect(state.initiatorAddress).toBe(OPS[0]!.address);
    expect(state.participants).toHaveLength(10);
    expect(state.localDigest).toBe(digest);
    expect(state.frozenDigest).toBe(digest);
    expect(state.digestMismatch).toBe(false);
    expect(state.validConsentCount).toBe(10);
    expect(state.ready).toBe(true);

    // Digest parity with the desktop's own V1 implementation.
    const parity = formClusterConsentMessageHex({
      activePubkeysHex: OPS.slice(0, 7).map((op) => op.pubkeyHex).join("\n"),
      standbyPubkeysHex: OPS.slice(7, 10).map((op) => op.pubkeyHex).join("\n"),
    });
    expect(state.localDigest).toBe(parity);

    // Roster rows in canonical order, every seat consented.
    const rows = ceremonyRoster(state);
    expect(rows).toHaveLength(10);
    expect(rows.map((row) => `${row.seat.role}:${row.seat.index}`)).toEqual([
      "active:0", "active:1", "active:2", "active:3", "active:4", "active:5", "active:6",
      "standby:0", "standby:1", "standby:2",
    ]);
    expect(rows.every((row) => row.consent?.status === "valid")).toBe(true);
  });

  it("hands off the paste-box shapes in roster order plus an OpRequest", () => {
    const { msgs } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);
    const input = buildClusterFormInput(state);
    expect(input).not.toBeNull();
    expect(input!.activePubkeysHex.split("\n")).toEqual(
      OPS.slice(0, 7).map((op) => op.pubkeyHex),
    );
    expect(input!.standbyPubkeysHex.split("\n")).toEqual(
      OPS.slice(7, 10).map((op) => op.pubkeyHex),
    );
    expect(input!.signaturesHex.split("\n")).toHaveLength(10);

    const request = buildClusterFormOpRequest(state);
    expect(request?.kind).toBe("cluster-form");
    expect(request?.clusterFormInput).toEqual(input);
    expect(request?.needsPasskey).toBe(true);
  });

  it("rejects a forged consent signature and a stale-digest consent", () => {
    const { msgs, msg, digest } = fullCeremonyMessages();
    // OPS[1] re-consents with a signature made by OPS[2]'s key (latest wins).
    const forged = msg({
      sender: OPS[1]!,
      body: {
        t: "consent",
        cid: CID,
        ref: PROPOSE_ID,
        consent_digest: digest,
        sig: signDigest(OPS[2]!, digest),
      },
    });
    const state = reduceCeremony([...msgs, forged]);
    expect(state.ready).toBe(false);
    expect(state.validConsentCount).toBe(9);
    const bad = state.consents.find((consent) => consent.address === OPS[1]!.address);
    expect(bad?.status).toBe("invalid-signature");

    // OPS[2] re-consents over a tampered digest → stale.
    const wrongDigest = `0x${"ab".repeat(32)}`;
    const stale = msg({
      sender: OPS[2]!,
      body: {
        t: "consent",
        cid: CID,
        ref: PROPOSE_ID,
        consent_digest: wrongDigest,
        sig: signDigest(OPS[2]!, wrongDigest),
      },
    });
    const state2 = reduceCeremony([...msgs, stale]);
    expect(state2.validConsentCount).toBe(9);
    expect(
      state2.consents.find((consent) => consent.address === OPS[2]!.address)?.status,
    ).toBe("stale-digest");
  });

  it("enforces pinned operator ids on seat claims", () => {
    const msg = makeMsgFactory();
    const msgs: ChatMessage[] = [
      msg({ sender: OPS[0]!, body: proposeBody(pinnedSeats()), id: PROPOSE_ID }),
      // OPS[1] tries to grab active:0, pinned to OPS[0].
      msg({
        sender: OPS[1]!,
        body: { t: "join", cid: CID, ref: PROPOSE_ID, seat: { role: "active", index: 0 } },
      }),
    ];
    const state = reduceCeremony(msgs);
    expect(state.participants).toHaveLength(0);
    expect(state.warnings.some((w) => w.includes("pinned to a different operator id"))).toBe(true);
  });

  it("rejects a malformed (wrong-length) charter fail-closed", () => {
    const msg = makeMsgFactory();
    const body = proposeBody();
    body.terms = { ...body.terms, charter: "0x" + "00".repeat(22) };
    const state = reduceCeremony([msg({ sender: OPS[0]!, body, id: PROPOSE_ID })]);
    expect(state.cid).toBeNull();
    expect(state.warnings.some((w) => w.includes("charter"))).toBe(true);
  });
});

// ---- charter (V2 economic terms) ---------------------------------------

const CHARTER_EXPIRES_MS = 3_000_000_000_000; // before the propose expiry
const CHARTER_SHARES = [1500, 1500, 1000, 1000, 1000, 1000, 1000, 800, 700, 500];

function makeCharterHex(overrides?: {
  memberShareBps?: number[];
  delegatorShareBps?: number;
  expiresMs?: number;
}): string {
  return encodeClusterCharterHex({
    memberShareBps: overrides?.memberShareBps ?? CHARTER_SHARES,
    delegatorShareBps: overrides?.delegatorShareBps ?? 3000,
    expiresMs: overrides?.expiresMs ?? CHARTER_EXPIRES_MS,
  });
}

/** Raw (unvalidated) charter hex for malformed-charter propose cases. */
function rawCharterHex(shares: number[], delegatorBps: number, expiresMs: number): string {
  const u16 = (n: number) => n.toString(16).padStart(4, "0");
  return `0x${shares.map(u16).join("")}${u16(delegatorBps)}${BigInt(expiresMs).toString(16).padStart(16, "0")}`;
}

describe("ceremony charter (V2)", () => {
  it("runs the charter ceremony on the V2 digest and hands off the V2 submit", () => {
    const charterHex = makeCharterHex();
    const { msgs, digest } = fullCeremonyMessages(OPS.slice(0, 10), charterHex);
    const state = reduceCeremony(msgs);

    expect(state.terms?.charter).toBe(charterHex);
    expect(state.localDigest).toBe(digest);
    expect(state.frozenDigest).toBe(digest);
    expect(state.digestMismatch).toBe(false);
    expect(state.validConsentCount).toBe(10);
    expect(state.ready).toBe(true);

    // Digest parity straight against the core-sdk V2 encoder (the same
    // bytes mono-core + the Rust signer derive for this roster+charter).
    const activeBlob = hexToBytes(
      OPS.slice(0, 7).map((op) => op.pubkeyHex.slice(2)).join(""),
    );
    const standbyBlob = hexToBytes(
      OPS.slice(7, 10).map((op) => op.pubkeyHex.slice(2)).join(""),
    );
    expect(state.localDigest).toBe(
      formClusterMessageV2Hex(activeBlob, standbyBlob, hexToBytes(charterHex)),
    );
    // …and the desktop clusterFormOps mirror agrees.
    expect(state.localDigest).toBe(
      formClusterConsentMessageHex({
        activePubkeysHex: OPS.slice(0, 7).map((op) => op.pubkeyHex).join("\n"),
        standbyPubkeysHex: OPS.slice(7, 10).map((op) => op.pubkeyHex).join("\n"),
        charterHex,
      }),
    );
    // The V2 digest is NOT the V1 digest for the same roster.
    expect(state.localDigest).not.toBe(rosterDigest(OPS.slice(0, 10)));

    // The submit hand-off carries the charter and selects the V2 executor.
    const input = buildClusterFormInput(state);
    expect(input?.charterHex).toBe(charterHex);
    const request = buildClusterFormOpRequest(state);
    expect(request?.clusterFormInput?.charterHex).toBe(charterHex);
    expect(
      request?.fields?.find((field) => field.key === "executor")?.value,
    ).toBe("formCluster(bytes,bytes,bytes,bytes)");
  });

  it("treats a charter change like any terms change — the digest shifts and every consent goes stale", () => {
    const roster = OPS.slice(0, 10);
    const charterA = makeCharterHex({ delegatorShareBps: 5000 });
    const charterB = makeCharterHex({ delegatorShareBps: 3000 });
    const digestA = rosterDigest(roster, charterA);
    const digestB = rosterDigest(roster, charterB);
    expect(digestA).not.toBe(digestB);

    // Same roster, propose pins charter B, but the consents (and the
    // freeze) were produced over charter A's digest.
    const msg = makeMsgFactory();
    const msgs: ChatMessage[] = [
      msg({ sender: OPS[0]!, body: proposeBody(openSeats(), charterB), id: PROPOSE_ID }),
    ];
    roster.forEach((op, i) => {
      const seat = i < 7 ? { role: "active" as const, index: i } : { role: "standby" as const, index: i - 7 };
      msgs.push(msg({ sender: op, body: { t: "join", cid: CID, ref: PROPOSE_ID, seat } }));
    });
    msgs.push(
      msg({ sender: OPS[0]!, body: { t: "freeze", cid: CID, ref: PROPOSE_ID, consent_digest: digestA } }),
    );
    for (const op of roster) {
      msgs.push(
        msg({
          sender: op,
          body: {
            t: "consent",
            cid: CID,
            ref: PROPOSE_ID,
            consent_digest: digestA,
            sig: signDigest(op, digestA),
          },
        }),
      );
    }
    const state = reduceCeremony(msgs);
    expect(state.localDigest).toBe(digestB);
    expect(state.consents.every((c) => c.status === "stale-digest")).toBe(true);
    expect(state.validConsentCount).toBe(0);
    expect(state.digestMismatch).toBe(true); // frozen A vs local B
    expect(state.ready).toBe(false);
    expect(canSubmitCeremony(state, OPS[0]!.address, 1_000).allowed).toBe(false);
  });

  it("rejects malformed charter proposals with the reason", () => {
    const cases: Array<{ terms: Partial<CeremonyTerms>; want: RegExp }> = [
      {
        // wrong length
        terms: { charter: "0x" + "ab".repeat(29), charter_hash: "" },
        want: /30-byte charter wire payload/u,
      },
      {
        // member shares sum 9999
        terms: (() => {
          const charter = rawCharterHex(
            [...CHARTER_SHARES.slice(0, 9), 499],
            3000,
            CHARTER_EXPIRES_MS,
          );
          return { charter, charter_hash: ceremonyCharterHashHex(charter) };
        })(),
        want: /sum to exactly 10000/u,
      },
      {
        // delegator share below the protocol floor
        terms: (() => {
          const charter = rawCharterHex(CHARTER_SHARES, 1999, CHARTER_EXPIRES_MS);
          return { charter, charter_hash: ceremonyCharterHashHex(charter) };
        })(),
        want: /below the protocol floor/u,
      },
      {
        // charter_hash mismatch
        terms: { charter: makeCharterHex(), charter_hash: "0x" + "11".repeat(32) },
        want: /charter_hash does not match/u,
      },
      {
        // charter_hash without charter bytes
        terms: { charter_hash: "0x" + "22".repeat(32) },
        want: /charter_hash is set but no charter/u,
      },
    ];
    for (const { terms, want } of cases) {
      const msg = makeMsgFactory();
      const body = proposeBody();
      body.terms = { ...body.terms, ...terms };
      const state = reduceCeremony([msg({ sender: OPS[0]!, body, id: PROPOSE_ID })]);
      expect(state.cid).toBeNull();
      expect(state.warnings.some((w) => want.test(w))).toBe(true);
    }
  });

  it("refuses submission once the charter consent expiry passes", () => {
    const charterHex = makeCharterHex({ expiresMs: CHARTER_EXPIRES_MS });
    const { msgs } = fullCeremonyMessages(OPS.slice(0, 10), charterHex);
    const state = reduceCeremony(msgs);
    expect(state.ready).toBe(true);

    // Before the charter expiry: allowed.
    expect(canSubmitCeremony(state, OPS[0]!.address, CHARTER_EXPIRES_MS - 1).allowed).toBe(true);
    // After the charter expiry (but before the propose expiry): refused.
    const verdict = canSubmitCeremony(state, OPS[0]!.address, CHARTER_EXPIRES_MS + 1);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/charter/u);
    expect(CHARTER_EXPIRES_MS + 1).toBeLessThan(EXPIRES_MS);
  });

  it("roundtrips a charter ceremony through export/import", () => {
    const charterHex = makeCharterHex();
    const { msgs } = fullCeremonyMessages(OPS.slice(0, 10), charterHex);
    const state = reduceCeremony(msgs);
    const json = exportCeremonyJson(state);

    const imported = importCeremonyJson(json);
    expect(imported.consentDigestHex).toBe(state.localDigest);
    expect(imported.terms.charter).toBe(charterHex);
    expect(imported.input.charterHex).toBe(charterHex);
    expect(imported.input).toEqual(buildClusterFormInput(state));

    // Tampering with the charter inside the export breaks the integrity hash…
    const tampered = json.replace(charterHex, makeCharterHex({ delegatorShareBps: 9000 }));
    expect(tampered).not.toBe(json);
    expect(() => importCeremonyJson(tampered)).toThrow(/integrity hash/iu);

    // …and a re-hashed charter swap still fails the digest recomputation:
    // the consents were signed over the ORIGINAL charter's V2 digest.
    const file = JSON.parse(json) as CeremonyExportFile;
    const swappedCharter = makeCharterHex({ delegatorShareBps: 9000 });
    file.terms = {
      ...file.terms,
      charter: swappedCharter,
      charter_hash: ceremonyCharterHashHex(swappedCharter),
    };
    const { export_hash: _drop, ...payload } = file;
    const rehashed: CeremonyExportFile = { ...payload, export_hash: ceremonyExportHash(payload) };
    expect(() => importCeremonyJson(JSON.stringify(rehashed))).toThrow(
      /consent digest does not match/u,
    );
  });
});

describe("ceremony reducer — withdraw invalidation", () => {
  it("withdraw deletes that sender's join+consent and stales every other consent", () => {
    const { msgs, msg, digest } = fullCeremonyMessages();
    const withdrawn = OPS[3]!;
    const withdraw = msg({
      sender: withdrawn,
      body: { t: "withdraw", cid: CID, ref: PROPOSE_ID },
    });
    const state = reduceCeremony([...msgs, withdraw]);

    expect(state.participants).toHaveLength(9);
    expect(state.participants.some((p) => p.address === withdrawn.address)).toBe(false);
    expect(state.consents.some((c) => c.address === withdrawn.address)).toBe(false);
    // Roster incomplete → no local digest → every surviving consent is stale.
    expect(state.localDigest).toBeNull();
    expect(state.validConsentCount).toBe(0);
    expect(state.ready).toBe(false);
    expect(state.consents.every((c) => c.status === "stale-digest")).toBe(true);
    expect(state.frozenDigest).toBe(digest); // the old pin survives but no longer matches anything
  });

  it("a replacement claim shifts the digest and requires fresh consents from everyone", () => {
    const { msgs, msg, digest: oldDigest } = fullCeremonyMessages();
    const withdrawn = OPS[3]!;
    const replacement = OPS[10]!;
    const next: ChatMessage[] = [
      ...msgs,
      msg({ sender: withdrawn, body: { t: "withdraw", cid: CID, ref: PROPOSE_ID } }),
      msg({
        sender: replacement,
        body: { t: "join", cid: CID, ref: PROPOSE_ID, seat: { role: "active", index: 3 } },
      }),
    ];

    const newRoster = OPS.slice(0, 10).map((op, i) => (i === 3 ? replacement : op));
    const newDigest = rosterDigest(newRoster);
    expect(newDigest).not.toBe(oldDigest);

    // Roster complete again, but old consents target the OLD digest.
    const midState = reduceCeremony(next);
    expect(midState.localDigest).toBe(newDigest);
    expect(midState.validConsentCount).toBe(0);
    expect(midState.ready).toBe(false);

    // Initiator re-freezes; all 10 current members re-consent over the new digest.
    next.push(
      msg({
        sender: OPS[0]!,
        body: { t: "freeze", cid: CID, ref: PROPOSE_ID, consent_digest: newDigest },
      }),
    );
    for (const op of newRoster) {
      next.push(
        msg({
          sender: op,
          body: {
            t: "consent",
            cid: CID,
            ref: PROPOSE_ID,
            consent_digest: newDigest,
            sig: signDigest(op, newDigest),
          },
        }),
      );
    }
    const state = reduceCeremony(next);
    expect(state.frozenDigest).toBe(newDigest);
    expect(state.digestMismatch).toBe(false);
    expect(state.validConsentCount).toBe(10);
    expect(state.ready).toBe(true);
  });
});

describe("ceremony reducer — late-join snapshot", () => {
  it("a late joiner reconstructs the full lobby from one initiator snapshot", () => {
    const { msgs } = fullCeremonyMessages();
    const direct = reduceCeremony(msgs);
    expect(direct.ready).toBe(true);

    const snapshotBody = buildCeremonySnapshotBody(direct);
    expect(snapshotBody).not.toBeNull();

    const msg = makeMsgFactory();
    const snapshotMsg = msg({ sender: OPS[0]!, body: snapshotBody });
    const replayed = reduceCeremony([snapshotMsg]);

    expect(replayed.cid).toBe(CID);
    expect(replayed.proposeMsgId).toBe(PROPOSE_ID);
    expect(replayed.initiatorAddress).toBe(OPS[0]!.address);
    expect(replayed.participants).toHaveLength(10);
    expect(replayed.localDigest).toBe(direct.localDigest);
    expect(replayed.frozenDigest).toBe(direct.frozenDigest);
    // Consent signatures are re-verified from the snapshot — readiness is earned, not copied.
    expect(replayed.validConsentCount).toBe(10);
    expect(replayed.ready).toBe(true);
    expect(replayed.participants.every((p) => p.viaSnapshot)).toBe(true);
  });

  it("rejects a snapshot whose sender is not the embedded initiator", () => {
    const { msgs } = fullCeremonyMessages();
    const direct = reduceCeremony(msgs);
    const snapshotBody = buildCeremonySnapshotBody(direct);
    const msg = makeMsgFactory();
    const forged = msg({ sender: OPS[1]!, body: snapshotBody });
    const state = reduceCeremony([forged]);
    expect(state.cid).toBeNull();
    expect(state.participants).toHaveLength(0);
    expect(state.warnings.some((w) => w.includes("not the ceremony initiator"))).toBe(true);
  });
});

describe("ceremony reducer — freeze digest mismatch refusal", () => {
  it("a frozen digest that disagrees with the local recomputation blocks readiness", () => {
    const msg = makeMsgFactory();
    const roster = OPS.slice(0, 10);
    const msgs: ChatMessage[] = [msg({ sender: OPS[0]!, body: proposeBody(), id: PROPOSE_ID })];
    roster.forEach((op, i) => {
      const seat = i < 7 ? { role: "active" as const, index: i } : { role: "standby" as const, index: i - 7 };
      msgs.push(msg({ sender: op, body: { t: "join", cid: CID, ref: PROPOSE_ID, seat } }));
    });
    const digest = rosterDigest(roster);
    const wrongDigest = `0x${"77".repeat(32)}`;
    msgs.push(
      msg({
        sender: OPS[0]!,
        body: { t: "freeze", cid: CID, ref: PROPOSE_ID, consent_digest: wrongDigest },
      }),
    );
    for (const op of roster) {
      msgs.push(
        msg({
          sender: op,
          body: {
            t: "consent",
            cid: CID,
            ref: PROPOSE_ID,
            consent_digest: digest,
            sig: signDigest(op, digest),
          },
        }),
      );
    }
    const state = reduceCeremony(msgs);
    expect(state.localDigest).toBe(digest);
    expect(state.frozenDigest).toBe(wrongDigest);
    expect(state.digestMismatch).toBe(true);
    expect(state.validConsentCount).toBe(10); // sigs ARE valid…
    expect(state.ready).toBe(false); // …but the pinned digest disagrees — refuse.

    const verdict = canSubmitCeremony(state, OPS[0]!.address, Date.now());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("digest");
  });

  it("ignores a freeze from anyone but the initiator", () => {
    const { msgs, msg, digest } = fullCeremonyMessages();
    const rogue = msg({
      sender: OPS[5]!,
      body: { t: "freeze", cid: CID, ref: PROPOSE_ID, consent_digest: `0x${"99".repeat(32)}` },
    });
    const state = reduceCeremony([...msgs, rogue]);
    expect(state.frozenDigest).toBe(digest);
    expect(state.warnings.some((w) => w.includes("non-initiator"))).toBe(true);
  });
});

describe("ceremony submit gating", () => {
  it("only an ACTIVE roster member may submit; standby and outsiders are refused", () => {
    const { msgs } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);
    const now = Date.now();

    expect(canSubmitCeremony(state, OPS[2]!.address, now).allowed).toBe(true);
    const standbyVerdict = canSubmitCeremony(state, OPS[8]!.address, now);
    expect(standbyVerdict.allowed).toBe(false);
    expect(standbyVerdict.reason).toContain("ACTIVE");
    expect(canSubmitCeremony(state, OPS[10]!.address, now).allowed).toBe(false);
    expect(canSubmitCeremony(state, null, now).allowed).toBe(false);
  });

  it("refuses after expiry and after a recorded submit", () => {
    const { msgs, msg } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);
    expect(canSubmitCeremony(state, OPS[0]!.address, EXPIRES_MS + 1).allowed).toBe(false);

    const submitted = reduceCeremony([
      ...msgs,
      msg({
        sender: OPS[0]!,
        body: { t: "submit", cid: CID, ref: PROPOSE_ID, tx_hash: `0x${"aa".repeat(32)}` },
      }),
    ]);
    expect(submitted.submitted?.txHash).toBe(`0x${"aa".repeat(32)}`);
    const verdict = canSubmitCeremony(submitted, OPS[0]!.address, Date.now());
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("already submitted");
  });
});

describe("ceremony export/import roundtrip", () => {
  it("roundtrips a ready ceremony through canonical JSON with real signatures", () => {
    const { msgs } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);
    const json = exportCeremonyJson(state);

    const imported = importCeremonyJson(json);
    expect(imported.cid).toBe(CID);
    expect(imported.consentDigestHex).toBe(state.localDigest);
    expect(imported.input).toEqual(buildClusterFormInput(state));
    expect(imported.seats).toHaveLength(10);
  });

  it("rejects a tampered export (integrity hash) and a re-hashed forged signature", () => {
    const { msgs } = fullCeremonyMessages();
    const state = reduceCeremony(msgs);
    const json = exportCeremonyJson(state);

    // (a) Any byte tamper breaks the canonical-JSON integrity hash.
    const tampered = json.replace('"cid": "abcd1234deadbeef"', '"cid": "abcd1234deadbee0"');
    expect(tampered).not.toBe(json);
    expect(() => importCeremonyJson(tampered)).toThrow(/integrity hash/iu);

    // (b) Recomputing the hash over a forged signature still fails ML-DSA verification.
    const file = JSON.parse(json) as CeremonyExportFile;
    const firstConsent = file.consents[0]!;
    firstConsent.sig_hex = signDigest(OPS[5]!, state.localDigest!); // wrong key for seat active:0
    const { export_hash: _drop, ...payload } = file;
    const rehashed: CeremonyExportFile = {
      ...payload,
      export_hash: ceremonyExportHash(payload),
    };
    expect(() => importCeremonyJson(JSON.stringify(rehashed))).toThrow(
      /failed ML-DSA-65 verification/u,
    );
  });

  it("verifies raw consent signatures directly", () => {
    const digest = rosterDigest(OPS.slice(0, 10));
    const sig = signDigest(OPS[0]!, digest);
    expect(
      verifyCeremonyConsentSignature({
        pubkeyHex: OPS[0]!.pubkeyHex,
        consentDigestHex: digest,
        signatureHex: sig,
      }),
    ).toBe(true);
    expect(
      verifyCeremonyConsentSignature({
        pubkeyHex: OPS[1]!.pubkeyHex,
        consentDigestHex: digest,
        signatureHex: sig,
      }),
    ).toBe(false);
  });
});

describe("ceremony transport — graceful degradation outside Tauri", () => {
  it("subscribe rejects with a typed transport-unavailable error", async () => {
    await expect(subscribeCeremonyChannel({ ceremonyId: CID })).rejects.toBeInstanceOf(
      CeremonyTransportUnavailableError,
    );
  });

  it("send enforces the ceremony body cap before invoking", async () => {
    const oversized = {
      t: "consent" as const,
      cid: CID,
      ref: PROPOSE_ID,
      consent_digest: `0x${"11".repeat(32)}`,
      sig: `0x${"22".repeat(13_000)}`,
    };
    await expect(sendCeremonyBody(CHANNEL_ID, oversized)).rejects.toThrow(/body cap/u);
  });

  it("parses only well-formed ceremony bodies", () => {
    expect(parseCeremonyBody("gm operators")).toBeNull();
    expect(parseCeremonyBody(JSON.stringify({ t: "join", cid: CID }))).toBeNull();
    expect(
      parseCeremonyBody(
        JSON.stringify({ t: "join", cid: CID, ref: PROPOSE_ID, seat: { role: "active", index: 0 } }),
      ),
    ).not.toBeNull();
  });
});
