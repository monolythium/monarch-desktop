// Pre-submit precondition checks ("PreflightChecks") for the Operations
// drawer. Before the operator can press "Authorize & run", per-verb
// preconditions are probed (keychain, registration, balance, service
// state) and rendered as green/red rows with fix-it links.
//
// Split into a pure rule evaluator (`buildPreflightRows`, unit-tested)
// and an async collector (`collectPreflightProbes`) that runs the
// existing src/sdk detectors. Probes use `boolean | null`:
//   true / false -> verified; null -> cannot verify on this runtime
//   (unavailable data is NOT the same as "not done").
// Only verified failures block authorization; unknowns never do.

import { mnemonicToAddress } from "@monolythium/core-sdk/crypto";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainGet,
  talosService,
} from "../sdk/bridge";
import { rpc } from "../sdk/client";
import { deriveOperatorConsensusPubkeyHex } from "../sdk/register";
import { operatorPubkeyHash } from "../sdk/operatorKeys";
import { MIN_REGISTER_BOND_LYTHOSHI } from "../sdk/onboarding";
import { FOUNDATION_OP_KINDS } from "./errors";
import type { OpKind, OpRequest } from "./types";

/** Verbs whose execution signs with the operator key. */
export const OPERATOR_SIGNED_KINDS: ReadonlySet<OpKind> = new Set<OpKind>([
  "operator-register",
  "operator-display",
  "chat-bootstrap-peers",
  "cluster-name-register",
  "rotate-keys",
  "redelegate",
  "cluster-request-join",
  "cluster-vote-admit",
  "cluster-resign",
  "cluster-form",
]);

export type PreflightStatus = "ok" | "fail" | "unknown" | "checking";

export type PreflightRow = {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  fixRoute?: string;
  fixLabel?: string;
};

export type PreflightProbes = {
  inTauri: boolean;
  hasOperatorKey: boolean | null;
  hasFoundationKey: boolean | null;
  walletAddress: string | null;
  balanceLythoshi: bigint | null;
  registered: boolean | null;
  /** ext-protocore service running on the paired node. */
  serviceRunning: boolean | null;
};

export const EMPTY_PREFLIGHT_PROBES: PreflightProbes = {
  inTauri: false,
  hasOperatorKey: null,
  hasFoundationKey: null,
  walletAddress: null,
  balanceLythoshi: null,
  registered: null,
  serviceRunning: null,
};

/** Which probe groups a verb needs — drives both the collector and rules. */
export function preflightNeeds(kind: OpKind): {
  operatorKey: boolean;
  foundationKey: boolean;
  registration: boolean;
  balance: boolean;
  service: boolean;
} {
  return {
    operatorKey: OPERATOR_SIGNED_KINDS.has(kind),
    foundationKey: FOUNDATION_OP_KINDS.has(kind),
    registration:
      kind === "operator-register" ||
      kind === "cluster-request-join" ||
      kind === "cluster-vote-admit" ||
      kind === "cluster-resign",
    balance: kind === "operator-register" || kind === "cluster-request-join",
    service: kind === "export-backup",
  };
}

/** The lythoshi the wallet must cover for this request, if any. */
export function requiredBondLythoshi(request: OpRequest): bigint | null {
  if (request.kind === "operator-register") {
    let bond = 0n;
    try {
      bond = BigInt(request.registerInput?.bondLythoshi ?? "0");
    } catch {
      bond = 0n;
    }
    return bond > MIN_REGISTER_BOND_LYTHOSHI ? bond : MIN_REGISTER_BOND_LYTHOSHI;
  }
  if (request.kind === "cluster-request-join") {
    try {
      const bond = BigInt(request.clusterJoinRequestInput?.bondLythoshi ?? "0");
      return bond > 0n ? bond : null;
    } catch {
      return null;
    }
  }
  return null;
}

function triState(
  probe: boolean | null,
  okWhen: boolean,
): PreflightStatus {
  if (probe === null) return "unknown";
  return probe === okWhen ? "ok" : "fail";
}

/**
 * Pure rule evaluator: probes -> rows for the given request. A row with
 * status "fail" blocks the Authorize button; "unknown" never blocks
 * (the executor still fails closed on a real precondition violation).
 */
export function buildPreflightRows(
  request: OpRequest,
  probes: PreflightProbes,
): PreflightRow[] {
  const needs = preflightNeeds(request.kind);
  const rows: PreflightRow[] = [];

  if (needs.operatorKey) {
    const status = triState(probes.hasOperatorKey, true);
    rows.push({
      id: "operator-key",
      label: "Operator key stored",
      status,
      detail:
        status === "ok"
          ? "24-word operator mnemonic found in the OS keychain."
          : status === "unknown"
            ? "Keychain checks need the Monarch Desktop app."
            : "No operator key stored — save or generate your 24-word operator mnemonic first.",
      fixRoute: status === "fail" ? "/keys" : undefined,
      fixLabel: status === "fail" ? "Open Keys" : undefined,
    });
  }

  if (needs.foundationKey) {
    const status = triState(probes.hasFoundationKey, true);
    rows.push({
      id: "foundation-key",
      label: "Recovery authorization",
      status,
      detail:
        status === "ok"
          ? "Recovery authorization is available on this install."
          : status === "unknown"
            ? "Keychain checks need the Monarch Desktop app."
            : "This recovery action is not available on this install.",
      fixRoute: status === "fail" ? "/keys" : undefined,
      fixLabel: status === "fail" ? "Open Keys" : undefined,
    });
  }

  if (needs.registration) {
    const wantRegistered = request.kind !== "operator-register";
    const status =
      probes.hasOperatorKey === false
        ? "unknown"
        : triState(probes.registered, wantRegistered);
    rows.push({
      id: "registration",
      label: wantRegistered ? "Operator registered" : "Not already registered",
      status,
      detail: wantRegistered
        ? status === "ok"
          ? "Registration row found on-chain."
          : status === "unknown"
            ? "Registration lookup is not available right now."
            : "Your operator is not registered yet — register (and bond) first."
        : status === "ok"
          ? "No existing registration for this key — safe to register."
          : status === "unknown"
            ? "Registration lookup is not available right now."
            : "This operator key is already registered — a second register would be rejected.",
      fixRoute:
        status === "fail" ? (wantRegistered ? "/setup-operator" : "/operator") : undefined,
      fixLabel:
        status === "fail" ? (wantRegistered ? "Set up operator" : "Open Operator") : undefined,
    });
  }

  if (needs.balance) {
    const required = requiredBondLythoshi(request);
    let status: PreflightStatus;
    let detail: string;
    if (required === null) {
      status = "unknown";
      detail = "Enter a bond amount to check it against your live balance.";
    } else if (probes.balanceLythoshi === null) {
      status = "unknown";
      detail = "Balance is not readable on this endpoint.";
    } else if (probes.balanceLythoshi >= required) {
      status = "ok";
      detail = "Wallet balance covers the bond.";
    } else {
      status = "fail";
      detail = probes.walletAddress
        ? `Balance does not cover the bond — fund ${probes.walletAddress}.`
        : "Wallet balance does not cover the bond.";
    }
    rows.push({
      id: "balance",
      label: "Balance covers bond",
      status,
      detail,
      fixRoute: status === "fail" ? "/wallets" : undefined,
      fixLabel: status === "fail" ? "Open Treasury" : undefined,
    });
  }

  if (needs.service) {
    const status = triState(probes.serviceRunning, false);
    rows.push({
      id: "service-stopped",
      label: "Node service stopped",
      status,
      detail:
        status === "ok"
          ? "ext-protocore is stopped — safe to export an offline backup."
          : status === "unknown"
            ? "Service state is not readable (no Talos control channel)."
            : "ext-protocore is running — stop the service before exporting a backup.",
      fixRoute: status === "fail" ? "/services" : undefined,
      fixLabel: status === "fail" ? "Open Services" : undefined,
    });
  }

  return rows;
}

export function preflightBlocked(rows: readonly PreflightRow[]): boolean {
  return rows.some((row) => row.status === "fail");
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found") || msg.includes("unknown operator");
}

/**
 * Async collector for the probes a verb needs. Failure-isolated: any
 * probe that cannot run resolves to null (unknown), never throws. The
 * operator mnemonic is read once and the cleartext dropped immediately
 * after deriving the wallet address + operator id.
 */
export async function collectPreflightProbes(kind: OpKind): Promise<PreflightProbes> {
  const tauri = inTauri();
  const needs = preflightNeeds(kind);
  const probes: PreflightProbes = { ...EMPTY_PREFLIGHT_PROBES, inTauri: tauri };

  let walletAddress: string | null = null;
  let operatorIdHex: string | null = null;

  if (tauri && (needs.operatorKey || needs.registration || needs.balance)) {
    try {
      const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
      probes.hasOperatorKey = Boolean(mnemonic);
      if (mnemonic) {
        try {
          walletAddress = mnemonicToAddress(mnemonic);
          const pubkeyHex = deriveOperatorConsensusPubkeyHex(mnemonic);
          operatorIdHex = bytesToHex(operatorPubkeyHash(hexToBytes(pubkeyHex)));
        } catch {
          walletAddress = null;
          operatorIdHex = null;
        }
      }
    } catch {
      probes.hasOperatorKey = null;
    }
  }
  probes.walletAddress = walletAddress;

  if (tauri && needs.foundationKey) {
    try {
      const foundation = await keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic);
      probes.hasFoundationKey = Boolean(foundation);
    } catch {
      probes.hasFoundationKey = null;
    }
  }

  const tasks: Promise<void>[] = [];

  if (needs.balance && walletAddress) {
    tasks.push(
      rpc
        .ethGetBalance(walletAddress)
        .then((result) => {
          probes.balanceLythoshi = BigInt(result.value);
        })
        .catch(() => {
          probes.balanceLythoshi = null;
        }),
    );
  }

  if (needs.registration && operatorIdHex) {
    const id = operatorIdHex;
    tasks.push(
      rpc
        .lythOperatorInfo(id)
        .then(() => {
          probes.registered = true;
        })
        .catch((err: unknown) => {
          probes.registered = isNotFound(err) ? false : null;
        }),
    );
  }

  if (needs.service && tauri) {
    tasks.push(
      talosService("ext-protocore")
        .then((result) => {
          const state = (result.service?.state ?? "").toLowerCase();
          if (!state) {
            probes.serviceRunning = null;
            return;
          }
          probes.serviceRunning = !(
            state.includes("stop") ||
            state.includes("finished") ||
            state.includes("inactive") ||
            state.includes("failed")
          );
        })
        .catch(() => {
          probes.serviceRunning = null;
        }),
    );
  }

  await Promise.all(tasks);
  return probes;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
