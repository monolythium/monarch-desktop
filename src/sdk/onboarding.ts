// First-run onboarding model: the auto-DETECTED 10-step operator
// checklist plus the probe bundle that gates LastViewRedirect.
//
// Split into a pure reducer (`reduceOnboardingSteps`, unit-tested) and
// an async collector (`collectOnboardingProbes`) that runs the existing
// src/sdk detectors. Probe results use `boolean | null` everywhere:
//   true  -> verified done
//   false -> verified NOT done
//   null  -> cannot verify (method not exposed / outside the desktop
//            runtime) - rendered as "unknown", never as "not done".

import { formatLyth } from "@monolythium/core-sdk";
import { pqm1MnemonicToAddress } from "@monolythium/core-sdk/crypto";
import { rpc } from "./client";
import {
  KEYCHAIN_ACCOUNTS,
  inTauri,
  keychainGet,
  sshStatus,
  talosStatus,
} from "./bridge";
import { extractChatBootstrapPeersFromOperatorMetadata } from "./chatConfig";
import { encodeGetOperatorSealKeyCalldata } from "./operatorSealKeyOps";
import { deriveOperatorConsensusPubkeyHex } from "./register";
import { operatorPubkeyHash } from "./operatorKeys";

/** Canonical download location for the Monarch OS image (step 1). */
export const MONARCH_OS_ISO_URL =
  "https://github.com/monolythium/monarch-os-talos/releases";

/** Testnet registration bond floor: 5,000 LYTH. */
export const MIN_REGISTER_BOND_LYTH = 5_000n;
export const MIN_REGISTER_BOND_LYTHOSHI = MIN_REGISTER_BOND_LYTH * 10n ** 18n;

const NODE_REGISTRY_ADDRESS_HEX = "0x0000000000000000000000000000000000001005";

export type OnboardingStepId =
  | "flash-iso"
  | "pair-node"
  | "operator-key"
  | "fund-bond"
  | "register"
  | "set-name"
  | "publish-seal-ek"
  | "publish-chat-peers"
  | "join-cluster"
  | "dkg-attestation";

export type OnboardingStepStatus =
  /** Verified complete. */
  | "done"
  /** Verified not complete - actionable now. */
  | "todo"
  /** Cannot start until an earlier step completes. */
  | "blocked"
  /** Cannot be verified on this endpoint/runtime ("not exposed" is NOT "not done"). */
  | "unknown";

export type OnboardingStep = {
  id: OnboardingStepId;
  n: number;
  title: string;
  detail: string;
  status: OnboardingStepStatus;
  /** External link (the Monarch OS image for step 1). */
  href?: string;
  /** In-app route that fixes/advances this step. */
  fixRoute?: string;
};

export type OnboardingProbeInputs = {
  /** Running inside the Tauri desktop runtime. */
  inTauri: boolean;
  /** Talos control channel configured / reachable. */
  talosConfigured: boolean | null;
  talosReachable: boolean | null;
  /** Dev SSH control channel connected. */
  sshConnected: boolean | null;
  /** RPC endpoint answered eth_chainId. */
  rpcReachable: boolean | null;
  /** PQM-1 operator mnemonic present in the OS keychain. */
  hasOperatorKey: boolean | null;
  /** Derived bech32m wallet address (requires the stored key). */
  walletAddress: string | null;
  /** Derived 32-byte operator id, 0x-hex (BLAKE3 of the consensus pubkey). */
  operatorIdHex: string | null;
  /** Live native balance in lythoshi. */
  balanceLythoshi: bigint | null;
  /** Operator registration row exists on-chain. */
  registered: boolean | null;
  /** Public moniker or alias is set. */
  hasDisplayName: boolean | null;
  /** LythiumSeal EK published. */
  sealEkPublished: boolean | null;
  /** Chat bootstrap multiaddrs published on-chain. */
  chatPeersPublished: boolean | null;
  /** Operator holds at least one active cluster seat. */
  inCluster: boolean | null;
  /** Registry lifecycle state ("active" once signing in a cluster). */
  lifecycleState: string | null;
};

export const EMPTY_ONBOARDING_PROBES: OnboardingProbeInputs = {
  inTauri: false,
  talosConfigured: null,
  talosReachable: null,
  sshConnected: null,
  rpcReachable: null,
  hasOperatorKey: null,
  walletAddress: null,
  operatorIdHex: null,
  balanceLythoshi: null,
  registered: null,
  hasDisplayName: null,
  sealEkPublished: null,
  chatPeersPublished: null,
  inCluster: null,
  lifecycleState: null,
};

function compactAddress(value: string | null): string {
  if (!value) return "";
  return value.length > 26 ? `${value.slice(0, 14)}…${value.slice(-8)}` : value;
}

/**
 * Pure reducer: probe inputs -> the 10 checklist rows.
 *
 * The reducer never fabricates progress: a `null` probe renders as
 * "unknown" with an explanation, and later chain steps stay "blocked"
 * until the key/registration they depend on is verified.
 */
export function reduceOnboardingSteps(p: OnboardingProbeInputs): OnboardingStep[] {
  const paired = p.talosReachable === true || p.rpcReachable === true;
  const pairProbesAvailable =
    p.inTauri || p.rpcReachable !== null;

  const flashIso: OnboardingStepStatus = paired
    ? "done"
    : pairProbesAvailable
      ? "todo"
      : "unknown";

  const pairNode: OnboardingStepStatus = paired
    ? "done"
    : pairProbesAvailable
      ? "todo"
      : "unknown";

  const operatorKey: OnboardingStepStatus =
    p.hasOperatorKey === null ? "unknown" : p.hasOperatorKey ? "done" : "todo";

  const keyDone = p.hasOperatorKey === true;

  const fundBond: OnboardingStepStatus = !keyDone
    ? "blocked"
    : p.balanceLythoshi === null
      ? "unknown"
      : p.balanceLythoshi >= MIN_REGISTER_BOND_LYTHOSHI
        ? "done"
        : "todo";

  const register: OnboardingStepStatus = !keyDone
    ? "blocked"
    : p.registered === null
      ? "unknown"
      : p.registered
        ? "done"
        : "todo";

  const registeredDone = p.registered === true;

  const afterRegister = (probe: boolean | null): OnboardingStepStatus => {
    if (!keyDone) return "blocked";
    if (p.registered === null) return "unknown";
    if (!registeredDone) return "blocked";
    return probe === null ? "unknown" : probe ? "done" : "todo";
  };

  const setName = afterRegister(p.hasDisplayName);
  const sealEk = afterRegister(p.sealEkPublished);
  const chatPeers = afterRegister(p.chatPeersPublished);
  const joinCluster = afterRegister(p.inCluster);

  const dkg: OnboardingStepStatus =
    joinCluster !== "done"
      ? "blocked"
      : p.lifecycleState === "active"
        ? "done"
        : "unknown";

  const balanceLabel =
    p.balanceLythoshi !== null
      ? `${formatLyth(p.balanceLythoshi)} of 5,000 LYTH minimum`
      : "balance not readable on this endpoint";

  return [
    {
      id: "flash-iso",
      n: 1,
      title: "Flash the Monarch OS image",
      detail:
        flashIso === "done"
          ? "A provisioned node is reachable - the image is installed."
          : "Download the signed Monarch OS image and flash it to your node. This step cannot be auto-detected until the node is paired.",
      status: flashIso,
      href: MONARCH_OS_ISO_URL,
    },
    {
      id: "pair-node",
      n: 2,
      title: "Pair Monarch with your node",
      detail:
        pairNode === "done"
          ? "Control channel and RPC respond."
          : pairNode === "unknown"
            ? "Pairing probes need the Monarch Desktop app."
            : "Connect the Talos control channel and confirm the RPC handshake on the Install page.",
      status: pairNode,
      fixRoute: "/install",
    },
    {
      id: "operator-key",
      n: 3,
      title: "Create or import your operator key",
      detail:
        operatorKey === "done"
          ? "A 24-word PQM-1 operator mnemonic is stored in the OS keychain."
          : operatorKey === "unknown"
            ? "Keychain checks need the Monarch Desktop app."
            : "Generate a new 24-word PQM-1 mnemonic (or paste an existing one) on the Keys page.",
      status: operatorKey,
      fixRoute: "/keys",
    },
    {
      id: "fund-bond",
      n: 4,
      title: "Fund the 5,000 LYTH bond",
      detail: !keyDone
        ? "Needs your operator key first - the funding address is derived from it."
        : `Send LYTH to ${compactAddress(p.walletAddress)} · ${balanceLabel}.`,
      status: fundBond,
      fixRoute: "/wallets",
    },
    {
      id: "register",
      n: 5,
      title: "Register your operator",
      detail:
        register === "done"
          ? "Registration row found on-chain."
          : register === "blocked"
            ? "Needs your operator key first."
            : register === "unknown"
              ? "Registration lookup is not exposed on this endpoint."
              : "Lock the bond and list your node so clusters can admit you.",
      status: register,
      fixRoute: "/setup-operator",
    },
    {
      id: "set-name",
      n: 6,
      title: "Set your operator name",
      detail:
        setName === "done"
          ? "A public moniker is published."
          : "Publish a human-readable name so other operators recognise your node.",
      status: setName,
      fixRoute: "/operator",
    },
    {
      id: "publish-seal-ek",
      n: 7,
      title: "Publish your seal key",
      detail:
        sealEk === "done"
          ? "Public seal key (ML-KEM encapsulation key) is on-chain."
          : "Required before a cluster can admit you into sealed-mempool duty.",
      status: sealEk,
      fixRoute: "/operator",
    },
    {
      id: "publish-chat-peers",
      n: 8,
      title: "Publish your chat peers",
      detail:
        chatPeers === "done"
          ? "Chat bootstrap addresses are published."
          : "Lets other operators reach you in operator chat - also the precondition for the cluster ceremony room.",
      status: chatPeers,
      fixRoute: "/operations",
    },
    {
      id: "join-cluster",
      n: 9,
      title: "Join or form a cluster",
      detail:
        joinCluster === "done"
          ? "You hold an active cluster seat."
          : "Request a seat in an existing cluster, or gather 10 operators in the ceremony room to form a new one.",
      status: joinCluster,
      fixRoute: "/ceremony",
    },
    {
      id: "dkg-attestation",
      n: 10,
      title: "DKG attestation",
      detail:
        dkg === "done"
          ? "Your seat is active - the cluster key ceremony is in effect."
          : dkg === "blocked"
            ? "Runs after you join a cluster."
            : "Attestation is verified per rotate intent; it cannot be separately detected here.",
      status: dkg,
      fixRoute: "/setup-cluster",
    },
  ];
}

/** True when any probe shows the operator has started configuring. */
export function onboardingConfigured(p: OnboardingProbeInputs): boolean {
  return (
    p.hasOperatorKey === true ||
    p.talosConfigured === true ||
    p.sshConnected === true ||
    p.registered === true
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      setTimeout(() => resolve(fallback), ms);
    }),
  ]);
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found") || msg.includes("unknown operator");
}

/** Decode the ABI `bytes` return of getOperatorSealKey: non-zero length = published. */
export function decodeSealEkPublished(callResult: string): boolean {
  const clean = callResult.startsWith("0x") ? callResult.slice(2) : callResult;
  if (clean.length < 128) return false;
  const len = Number.parseInt(clean.slice(64, 128), 16);
  return Number.isFinite(len) && len > 0;
}

/**
 * Quick "is anything configured?" probe for LastViewRedirect. Bounded
 * to ~1.2s so a cold keychain/Talos bridge never delays first paint.
 */
export async function quickConfiguredProbe(): Promise<boolean> {
  if (!inTauri()) {
    // Browser preview has no keychain/Talos - treat a reachable RPC
    // endpoint as configured so dev previews land on the dashboard.
    return withTimeout(
      rpc.ethChainId().then(() => true).catch(() => false),
      1_200,
      false,
    );
  }
  const [key, talos, ssh] = await Promise.all([
    withTimeout(
      keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic).catch(() => null),
      1_200,
      null,
    ),
    withTimeout(
      talosStatus().catch(() => null),
      1_200,
      null,
    ),
    withTimeout(
      sshStatus().catch(() => null),
      1_200,
      null,
    ),
  ]);
  return Boolean(key) || Boolean(talos?.configured) || Boolean(ssh?.connected);
}

/**
 * Full probe bundle for the Welcome checklist. Every probe is
 * independent and failure-isolated; the mnemonic is read once, the ids
 * are derived, and the cleartext is dropped before any await on chain
 * reads (never logged, never stored).
 */
export async function collectOnboardingProbes(): Promise<OnboardingProbeInputs> {
  const tauri = inTauri();

  const [talos, ssh, chainId, storedKey] = await Promise.all([
    tauri ? talosStatus().catch(() => null) : Promise.resolve(null),
    tauri ? sshStatus().catch(() => null) : Promise.resolve(null),
    withTimeout(
      rpc.ethChainId().then(() => true).catch(() => false),
      4_000,
      false,
    ),
    tauri
      ? keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic).catch(() => null)
      : Promise.resolve(null),
  ]);

  let walletAddress: string | null = null;
  let operatorIdHex: string | null = null;
  let hasOperatorKey: boolean | null = tauri ? false : null;
  if (storedKey) {
    hasOperatorKey = true;
    try {
      // Derive ids in this scope only; the mnemonic itself is never
      // retained past this block.
      walletAddress = pqm1MnemonicToAddress(storedKey);
      const pubkeyHex = deriveOperatorConsensusPubkeyHex(storedKey);
      const pubkeyBytes = hexToBytes(pubkeyHex);
      operatorIdHex = bytesToHex(operatorPubkeyHash(pubkeyBytes));
    } catch {
      walletAddress = null;
      operatorIdHex = null;
    }
  }

  let balanceLythoshi: bigint | null = null;
  if (walletAddress && chainId) {
    try {
      const proof = await rpc.ethGetBalance(walletAddress);
      balanceLythoshi = BigInt(proof.value);
    } catch {
      balanceLythoshi = null;
    }
  }

  let registered: boolean | null = null;
  let hasDisplayName: boolean | null = null;
  let inCluster: boolean | null = null;
  let lifecycleState: string | null = null;
  if (operatorIdHex && chainId) {
    try {
      const info = await rpc.lythOperatorInfo(operatorIdHex);
      registered = true;
      hasDisplayName = Boolean(info.moniker?.trim() || info.alias?.trim());
      inCluster = info.activeClusterIds.length > 0;
      lifecycleState = info.lifecycleState ?? null;
    } catch (err) {
      if (isNotFound(err)) {
        registered = false;
        hasDisplayName = false;
        inCluster = false;
      }
      // method-not-found / transport errors leave the probes null.
    }
  }

  let sealEkPublished: boolean | null = null;
  if (operatorIdHex && chainId) {
    try {
      const data = encodeGetOperatorSealKeyCalldata({ operatorIdHex });
      const result = await rpc.ethCall({ to: NODE_REGISTRY_ADDRESS_HEX, data });
      sealEkPublished = decodeSealEkPublished(result);
    } catch {
      // Revert / unknown selector / transport failure: cannot verify.
      sealEkPublished = null;
    }
  }

  let chatPeersPublished: boolean | null = null;
  if (operatorIdHex && chainId) {
    try {
      const metadata = await rpc.lythGetOperatorNetworkMetadata(operatorIdHex);
      chatPeersPublished =
        extractChatBootstrapPeersFromOperatorMetadata(metadata).length > 0;
    } catch (err) {
      chatPeersPublished = isNotFound(err) ? false : null;
    }
  }

  return {
    inTauri: tauri,
    talosConfigured: talos ? talos.configured : tauri ? false : null,
    talosReachable: talos ? talos.reachable : tauri ? false : null,
    sshConnected: ssh ? ssh.connected : tauri ? false : null,
    rpcReachable: chainId,
    hasOperatorKey,
    walletAddress,
    operatorIdHex,
    balanceLythoshi,
    registered,
    hasDisplayName,
    sealEkPublished,
    chatPeersPublished,
    inCluster,
    lifecycleState,
  };
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
