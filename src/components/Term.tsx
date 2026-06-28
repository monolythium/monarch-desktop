// Glossary tooltip. Wrap jargon in <Term k="bond">bond</Term> and the
// word renders with a dotted underline plus a plain-language tooltip
// (native title + accessible aria-label). One glossary map feeds every
// surface so definitions never drift.

import type { ReactNode } from "react";

export const GLOSSARY: Record<string, string> = {
  operator:
    "One physical node run by one person or team. Operators register on-chain, post a bond, and join clusters.",
  cluster:
    "A group of 10 operators (7 active + 3 standby) that signs together. 7 of the 10 must agree for the cluster to act.",
  relay:
    "A node that carries network traffic but takes no part in consensus signing.",
  bond:
    "5,000 LYTH locked from your wallet when you register. It backs your good behaviour and is refundable after you resign and the delay passes.",
  delegation:
    "LYTH that holders assign to a cluster to share in its rewards. Delegating never gives the cluster control of the holder's funds.",
  seat:
    "One of the 10 operator positions in a cluster - 7 active seats sign every round, 3 standby seats wait to rotate in.",
  threshold:
    "The minimum number of cluster operators (7 of 10) whose signatures are needed for the cluster to act.",
  quorum:
    "Enough operators online and signing for the cluster to keep making progress.",
  "CJ-1":
    "The self-service cluster-join flow: you request a seat, the current members vote, and the chain admits you when enough votes land.",
  lythoshi:
    "The smallest unit of LYTH. 1 LYTH = 1,000,000,000,000,000,000 lythoshi (10^18).",
  epoch:
    "A fixed span of rounds after which membership and key changes take effect.",
  "possession proof":
    "A signature proving you control the key you are registering - it stops anyone registering a key they do not own.",
  moniker:
    "The public, human-readable name other operators and explorers see for your node.",
  nonce:
    "A counter that makes each signed action unique. Each new action must use a higher number than the last accepted one.",
  ServiceScore:
    "The per-cluster score the chain reads each block to size your reward. It is earned from the services your cluster proves - signing, archive custody, GPU proving, RPC, indexing, and roster diversity - not from how much stake it holds.",
  "service reward":
    "Block rewards are paid for proved service, not stake. Stake only sets your cluster's rank; what you earn tracks your cluster's settled ServiceScore.",
};

export type TermProps = {
  /** Glossary key. Unknown keys render children without a tooltip. */
  k: string;
  /** Visible text; defaults to the glossary key itself. */
  children?: ReactNode;
};

export function Term({ k, children }: TermProps) {
  const definition = GLOSSARY[k];
  const text = children ?? k;
  if (!definition) return <>{text}</>;
  return (
    <span
      title={definition}
      aria-label={`${k}: ${definition}`}
      tabIndex={0}
      style={{
        textDecoration: "underline dotted",
        textDecorationColor: "var(--fg-400)",
        textUnderlineOffset: 3,
        cursor: "help",
      }}
    >
      {text}
    </span>
  );
}
