import { blake3 } from "@noble/hashes/blake3.js";

export const NODE_REGISTRY_CONSENSUS_PUBKEY_BYTES = 1952;
export const NODE_REGISTRY_CONSENSUS_POP_BYTES = 3309;
export const NODE_REGISTRY_DKG_ATTESTATION_SIG_BYTES = 3309;

const REGISTER_POP_DOMAIN_BYTES = new TextEncoder().encode(
  "PROTOCORE_PQ4S_OP_REGISTER_POSSESSION_V1\0",
);

export function registerPopMessage(consensusPubkey: Uint8Array): Uint8Array {
  const preimage = new Uint8Array(REGISTER_POP_DOMAIN_BYTES.length + consensusPubkey.length);
  preimage.set(REGISTER_POP_DOMAIN_BYTES, 0);
  preimage.set(consensusPubkey, REGISTER_POP_DOMAIN_BYTES.length);
  return blake3(preimage);
}

export function operatorPubkeyHash(consensusPubkey: Uint8Array): Uint8Array {
  return blake3(consensusPubkey);
}
