// Address display helpers.
//
// The chain's canonical, send-to-able address form is bech32m `mono1…`.
// Raw `0x` hex is the EVM-compat representation and is REJECTED by send
// paths (`protocore tx send` / wallets), so any "send LYTH here" / receive
// address shown to a human MUST be the `mono1` form — otherwise people copy
// the hex and their transfers bounce.

import { addressToBech32 } from "@monolythium/core-sdk";

/**
 * Normalize an address to its canonical `mono1…` bech32m form for display
 * and copy. Passes `mono1…` through unchanged; converts `0x…` hex via the
 * SDK; returns the input unchanged if it's neither (or conversion fails) so
 * the UI degrades gracefully rather than throwing.
 */
export function toMono1(addr: string | null | undefined): string | null {
  if (!addr) return null;
  if (addr.startsWith("mono1")) return addr;
  if (addr.startsWith("0x")) {
    try {
      return addressToBech32(addr);
    } catch {
      return addr;
    }
  }
  return addr;
}

/** Short, middle-elided form of any address string (works for mono1 + hex). */
export function shortAddr(addr: string | null | undefined, head = 12, tail = 8): string {
  if (!addr) return "—";
  if (addr.length <= head + tail + 1) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}
