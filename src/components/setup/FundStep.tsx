// Step 3 — Fund the bond.
//
// Shows the operator's funding address (derived in Step 2) and its LIVE native
// balance read straight from the connected node (`rpc.ethGetBalance`), against
// the registration bond floor (`MIN_REGISTER_BOND_LYTH`, the documented 5,000
// LYTH testnet minimum). The balance is polled every 8s and the step flips to
// "funded" the instant it covers the bond.
//
// There is no faucet RPC/bridge method in the SDK (verified — nothing in
// `@monolythium/core-sdk` exposes a faucet, and there is no local faucet
// command), so rather than fake a "Request from faucet" button this step shows
// the copy-able address plus instructions to fund it. The testnet faucet
// (monobot) is operated out-of-band; the honest affordance is the address.

import { useCallback, useEffect, useRef, useState } from "react";
import { formatLyth } from "@monolythium/core-sdk";
import { rpc } from "../../sdk";
import { MIN_REGISTER_BOND_LYTH, MIN_REGISTER_BOND_LYTHOSHI } from "../../sdk/onboarding";
import { CopyButton } from "./CopyButton";
import { StepShell } from "./StepShell";

const POLL_MS = 8_000;

export function FundStep({
  n,
  address,
  onFunded,
}: {
  n: number;
  address: string | null;
  /** Fired once the live balance covers the bond. */
  onFunded: () => void;
}) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const firedRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const proof = await rpc.ethGetBalance(address);
      const value = BigInt(proof.value);
      setBalance(value);
      setError(null);
      if (value >= MIN_REGISTER_BOND_LYTHOSHI && !firedRef.current) {
        firedRef.current = true;
        onFunded();
      }
    } catch (err) {
      setError((err as Error)?.message ?? String(err));
    } finally {
      setRefreshing(false);
    }
  }, [address, onFunded]);

  useEffect(() => {
    if (!address) return;
    void refresh();
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [address, refresh]);

  const covers = balance !== null ? balance >= MIN_REGISTER_BOND_LYTHOSHI : null;

  return (
    <StepShell
      n={n}
      title="Fund your bond"
      sub={`Registering locks a refundable bond from this address. The testnet floor is ${MIN_REGISTER_BOND_LYTH.toLocaleString()} LYTH.`}
    >
      {!address ? (
        <div className="halo halo--warn" style={{ alignSelf: "flex-start" }}>
          <span className="dot" /> Create or import your operator key first — the funding address is
          derived from it.
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 14 }}>
            <div className="cap" style={{ marginBottom: 6 }}>send LYTH to this address</div>
            <div className="setup__addr">
              {address}
              <CopyButton value={address} label="Copy funding address" />
            </div>
          </div>

          <div className="setup__result-grid">
            <div className="setup__stat">
              <div className="cap">live balance</div>
              <div
                className="setup__stat-v"
                style={{
                  color:
                    covers === true ? "var(--ok)" : covers === false ? "var(--err)" : "var(--fg-100)",
                }}
              >
                {balance !== null ? formatLyth(balance) : error ? "unreadable" : "…"}
              </div>
            </div>
            <div className="setup__stat">
              <div className="cap">bond required</div>
              <div className="setup__stat-v setup__stat-v--gold">
                {MIN_REGISTER_BOND_LYTH.toLocaleString()} LYTH
              </div>
            </div>
            <div className="setup__stat">
              <div className="cap">status</div>
              <div className="setup__stat-v">
                {covers === true ? "funded" : covers === false ? "needs LYTH" : "checking"}
              </div>
            </div>
          </div>

          <div className="setup__foot">
            {covers === true ? (
              <span className="halo halo--ok">
                <span className="dot" /> bond covered
              </span>
            ) : (
              <span className="halo halo--warn">
                <span className={refreshing ? "dot dot--pulse" : "dot"} />{" "}
                {refreshing ? "checking balance…" : "waiting for funds"}
              </span>
            )}
            <span className="setup__foot-spacer" />
            <button type="button" className="btn btn--sm" onClick={() => void refresh()} disabled={refreshing}>
              Refresh
            </button>
          </div>

          {error ? (
            <p style={{ fontSize: 11, color: "var(--fg-400)", margin: "10px 0 0" }}>
              Balance not readable on this endpoint: {error}
            </p>
          ) : null}

          <p style={{ fontSize: 11.5, color: "var(--fg-400)", margin: "12px 0 0", lineHeight: 1.5 }}>
            On testnet, request LYTH from the faucet (the monobot faucet, operated out-of-band) or
            from another funded account. This view polls the live balance and continues automatically
            once it covers the bond.
          </p>
        </>
      )}
    </StepShell>
  );
}
