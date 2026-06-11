// Resolve the operator's OWN identity from the stored PQM-1 mnemonic.
//
// Kills the "cluster-0 member[0] is you" assumption: views ask this
// hook who the local operator actually is (derived operator id + wallet
// address) and which cluster seat - if any - that identity holds.
//
// Security discipline: the mnemonic is read from the OS keychain,
// the ids are derived in a local scope, and the cleartext is dropped
// immediately. It is never logged, never put in React state, and never
// leaves this module.

import { useEffect, useState } from "react";
import { pqm1MnemonicToAddress } from "@monolythium/core-sdk/crypto";
import {
  KEYCHAIN_ACCOUNTS,
  deriveOperatorConsensusPubkeyHex,
  inTauri,
  keychainGet,
  operatorPubkeyHash,
} from "../sdk";
import { rpc } from "../sdk/client";

const REFRESH_MS = 15_000;

export type SelfOperatorStatus = "checking" | "no-key" | "ready" | "error";

export type SelfOperator = {
  status: SelfOperatorStatus;
  /** 0x-hex 32-byte operator id (BLAKE3 of the consensus pubkey). */
  operatorId: string | null;
  /** bech32m `mono1…` wallet address derived from the same key. */
  address: string | null;
  /** First active cluster seat from lyth_operatorInfo, else null. */
  clusterId: number | null;
  /** true/false when verifiable on-chain; null when the lookup is unavailable. */
  registered: boolean | null;
  /** Registry lifecycle state when registered. */
  lifecycleState: string | null;
  error: string | null;
};

const CHECKING: SelfOperator = {
  status: "checking",
  operatorId: null,
  address: null,
  clusterId: null,
  registered: null,
  lifecycleState: null,
  error: null,
};

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

/** Derive the operator id + wallet address from a mnemonic. Pure. */
export function deriveSelfOperatorIds(mnemonic: string): {
  operatorId: string;
  address: string;
} {
  const pubkeyHex = deriveOperatorConsensusPubkeyHex(mnemonic);
  const operatorId = bytesToHex(operatorPubkeyHash(hexToBytes(pubkeyHex)));
  const address = pqm1MnemonicToAddress(mnemonic);
  return { operatorId, address };
}

/**
 * Find the local operator's seat in a cluster member list. Pure -
 * powers the YOU badge. Returns the zero-based member index, or null.
 */
export function matchSelfMember(
  members: readonly { operatorId: string }[],
  selfOperatorId: string | null | undefined,
): number | null {
  if (!selfOperatorId) return null;
  const target = selfOperatorId.trim().toLowerCase();
  if (!target) return null;
  const index = members.findIndex(
    (member) => member.operatorId.trim().toLowerCase() === target,
  );
  return index === -1 ? null : index;
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; message?: string } | null;
  const msg = (e?.message ?? "").toLowerCase();
  return e?.code === -32090 || msg.includes("not found") || msg.includes("unknown operator");
}

/**
 * The local operator's identity + on-chain registration view.
 *
 * - `no-key`: nothing stored in the keychain (or browser preview) -
 *   views should render a "set up your operator key" CTA instead of
 *   borrowing some other member's stats.
 * - `ready`: ids derived; `registered`/`clusterId` reflect the live
 *   registry lookup and refresh every 15s.
 */
export function useSelfOperator(): SelfOperator {
  const [state, setState] = useState<SelfOperator>(CHECKING);

  useEffect(() => {
    let cancelled = false;
    let interval: number | null = null;

    const resolveChain = async (operatorId: string, address: string) => {
      try {
        const info = await rpc.lythOperatorInfo(operatorId);
        if (cancelled) return;
        setState({
          status: "ready",
          operatorId,
          address,
          clusterId: info.activeClusterIds[0] ?? null,
          registered: true,
          lifecycleState: info.lifecycleState ?? null,
          error: null,
        });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "ready",
          operatorId,
          address,
          clusterId: null,
          registered: isNotFound(err) ? false : null,
          lifecycleState: null,
          error: null,
        });
      }
    };

    void (async () => {
      if (!inTauri()) {
        if (!cancelled) setState({ ...CHECKING, status: "no-key" });
        return;
      }
      let ids: { operatorId: string; address: string } | null = null;
      try {
        const mnemonic = await keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic);
        if (cancelled) return;
        if (!mnemonic) {
          setState({ ...CHECKING, status: "no-key" });
          return;
        }
        // Derive in this scope; the cleartext is dropped right after.
        ids = deriveSelfOperatorIds(mnemonic);
      } catch (err) {
        if (cancelled) return;
        setState({
          ...CHECKING,
          status: "error",
          error: (err as Error)?.message ?? String(err),
        });
        return;
      }
      const { operatorId, address } = ids;
      setState({
        status: "ready",
        operatorId,
        address,
        clusterId: null,
        registered: null,
        lifecycleState: null,
        error: null,
      });
      void resolveChain(operatorId, address);
      interval = window.setInterval(
        () => void resolveChain(operatorId, address),
        REFRESH_MS,
      );
    })();

    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, []);

  return state;
}

export type KeychainPresence = {
  checking: boolean;
  hasOperatorKey: boolean;
  hasFoundationKey: boolean;
};

/**
 * Lightweight "which signers are stored?" probe shared by the nav,
 * Operations grid (foundation-verb gating), and setup views.
 */
export function useKeychainPresence(): KeychainPresence {
  const [state, setState] = useState<KeychainPresence>({
    checking: true,
    hasOperatorKey: false,
    hasFoundationKey: false,
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!inTauri()) {
        if (!cancelled) {
          setState({ checking: false, hasOperatorKey: false, hasFoundationKey: false });
        }
        return;
      }
      const [operator, foundation] = await Promise.all([
        keychainGet(KEYCHAIN_ACCOUNTS.operatorMnemonic).catch(() => null),
        keychainGet(KEYCHAIN_ACCOUNTS.foundationRecoveryMnemonic).catch(() => null),
      ]);
      if (cancelled) return;
      setState({
        checking: false,
        hasOperatorKey: Boolean(operator),
        hasFoundationKey: Boolean(foundation),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
