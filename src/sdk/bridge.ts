// Tauri 2 IPC bridge.
//
// Wraps `@tauri-apps/api/core` so the rest of the React app talks to
// the Rust side through small, typed helpers. When the app is loaded
// in a plain browser (`pnpm dev`), `isTauri()` returns false and every
// helper resolves to a safe empty/unavailable state so the app renders
// without fabricating node data.
//
// The set of commands here mirrors `src-tauri/src/lib.rs::run`:
//
//   ssh_connect / ssh_exec / ssh_exec_stream / ssh_exec_cancel /
//   ssh_status / ssh_disconnect
//   talos_connect / talos_status / talos_config_info / talos_trust_config /
//   talos_service / talos_protocore_readiness / talos_host_telemetry /
//   talos_export_protocore_backup / talos_upgrade / talos_rollback /
//   talos_logs / talos_log_stream
//   keychain_set / keychain_get / keychain_delete

import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { RuntimeProvenanceResponse } from "@monolythium/core-sdk";
import type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";
import { recordE2eCommand } from "./e2eRecorder";

// ---- environment helpers ------------------------------------------

/** True when the page is loaded inside the Tauri webview. */
export function inTauri(): boolean {
  return isTauri();
}

// ---- keychain ------------------------------------------------------

/** Canonical keychain accounts owned by the desktop app. */
export const KEYCHAIN_ACCOUNTS = {
  sshHost: "ssh:host",
  sshUser: "ssh:user",
  sshKeyPath: "ssh:key-path",
  sshPassphrase: "ssh:passphrase",
  talosEndpoint: "talos:endpoint",
  talosConfigPath: "talos:config-path",
  talosCaFingerprint: "talos:ca-fingerprint",
  protocoreExpectedDigest: "protocore:expected-digest",
  /// Hosted provider API key for Ask Monarch. The Rust side reads
  /// this just before issuing the HTTPS request; nothing in the React
  /// process ever holds the cleartext key once it has been written.
  hostedProviderApiKey: "hosted-provider-api-key",
  /// PQM-1 mnemonic for the operator's chain-signing key. The Ops
  /// drawer reads this in-memory just long enough to construct the
  /// register tx; the secret never leaves the Tauri sandbox.
  operatorMnemonic: "operator:mnemonic",
  /// Foundation-only PQM-1 mnemonic used to submit recoverOperatorNode(bytes32)
  /// and submitPendingChange(uint8,bytes,uint64,uint64). Ordinary operator
  /// installs should leave this absent; foundation-gated actions fail closed.
  foundationRecoveryMnemonic: "foundation:recovery-mnemonic",
} as const;

export async function keychainSet(account: string, secret: string): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("keychain_set", { account, secret });
}

/** Returns null when the entry is missing rather than throwing. */
export async function keychainGet(account: string): Promise<string | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<string>("keychain_get", { account });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    if (/not found/i.test(msg)) return null;
    throw err;
  }
}

export async function keychainDelete(account: string): Promise<void> {
  if (!inTauri()) return;
  try {
    await invoke<void>("keychain_delete", { account });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // Tolerate "not found" — caller is asking for absence either way.
    if (/not found/i.test(msg)) return;
    throw err;
  }
}

// ---- ssh -----------------------------------------------------------

export type SshStatus = {
  connected: boolean;
  host: string | null;
  user: string | null;
};

export async function sshConnect(args: {
  host: string;
  user: string;
  keyPath: string;
}): Promise<void> {
  if (!inTauri()) {
    throw new Error("ssh_connect unavailable — running outside Tauri");
  }
  await invoke<void>("ssh_connect", {
    host: args.host,
    user: args.user,
    keyPath: args.keyPath,
  });
}

/**
 * Run a single command on the held SSH session. Returns stdout. Throws
 * a typed error message starting with "no active ssh session" when
 * nothing is connected — callers can catch that for browser-only preview
 * acknowledgement while Tauri surfaces real host failures.
 */
export async function sshExec(cmd: string): Promise<string> {
  if (!inTauri()) {
    throw new Error("no active ssh session — running outside Tauri");
  }
  return await invoke<string>("ssh_exec", { cmd });
}

export async function sshStatus(): Promise<SshStatus> {
  if (!inTauri()) return { connected: false, host: null, user: null };
  const tuple = await invoke<[string, string] | null>("ssh_status");
  if (!tuple) return { connected: false, host: null, user: null };
  return { connected: true, host: tuple[0], user: tuple[1] };
}

export async function sshDisconnect(): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("ssh_disconnect");
}

// ---- "is the session live?" classifier ----------------------------

/**
 * True if the error returned from `sshExec` indicates no active
 * session. Used by the Operations drawer to decide between browser-only
 * preview acknowledgement and surfacing the real failure.
 */
export function isNoSessionError(err: unknown): boolean {
  const msg = (err as Error)?.message ?? String(err);
  return /no active ssh session/i.test(msg);
}

// ---- Talos / Monarch OS control plane -----------------------------

export type TalosStatus = {
  configured: boolean;
  reachable: boolean;
  endpoint: string | null;
  nodeAddress: string | null;
  configPath: string | null;
  clientMode: string;
  version: string | null;
  lastError: string | null;
};

export type TalosCertificateInfo = {
  role: string;
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  sha256Fingerprint: string;
  expired: boolean;
  notYetValid: boolean;
  expiresInDays: number;
  dnsNames: string[];
  ipAddresses: string[];
};

export type TalosConfigInfo = {
  path: string;
  context: string;
  endpoint: string;
  serverName: string;
  caFingerprint: string;
  trustedCaFingerprint: string | null;
  caPinStatus: "matched" | "mismatch" | "untrusted" | string;
  endpoints: string[];
  nodes: string[];
  certificates: TalosCertificateInfo[];
  warnings: string[];
};

export type TalosServiceEvent = {
  message: string;
  state: string;
  timestamp: string | null;
};

export type TalosServiceInfo = {
  id: string;
  state: string;
  displayState: string;
  severity: "ok" | "warn" | "err" | "info" | string;
  summary: string;
  healthy: boolean | null;
  healthUnknown: boolean | null;
  healthMessage: string | null;
  lastEvent: TalosServiceEvent | null;
  events: TalosServiceEvent[];
};

export type TalosTextResult = {
  endpoint: string;
  nodeAddress: string;
  command: string;
  output: string;
  service: TalosServiceInfo | null;
};

export type TalosBackupResult = {
  endpoint: string;
  nodeAddress: string;
  command: string;
  output: string;
  archivePath: string;
  archiveSha256: string;
  archiveSizeBytes: number;
  manifestPath: string;
  manifestSha256: string;
  sourcePath: string;
  service: TalosServiceInfo | null;
};

export type TalosOperatorSealEkResult = {
  endpoint: string;
  nodeAddress: string;
  command: string;
  path: string;
  sealEkHex: string;
  sha256: string;
};

export type TalosReadinessCheck = {
  name: string;
  state: "ok" | "warn" | "err" | "info" | string;
  message: string;
};

export type ProtocoreReadiness = {
  service: TalosServiceInfo | null;
  rpcEndpoint: string;
  displayState: string;
  severity: "ok" | "warn" | "err" | "info" | string;
  summary: string;
  chainId: number | null;
  blockNumber: number | null;
  clientVersion: string | null;
  listening: boolean | null;
  syncing: boolean | null;
  checks: TalosReadinessCheck[];
};

export type TalosLoadAverage = {
  load1: number;
  load5: number;
  load15: number;
};

export type TalosMemoryTelemetry = {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
};

export type TalosMountTelemetry = {
  filesystem: string;
  mountedOn: string;
  sizeBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
};

export type TalosNetworkTelemetry = {
  name: string;
  rxBytes: number;
  txBytes: number;
  rxErrors: number;
  txErrors: number;
  rxDropped: number;
  txDropped: number;
};

export type TalosDiskIoTelemetry = {
  name: string;
  readBytes: number;
  writeBytes: number;
  ioInProgress: number;
};

export type TalosDiskTelemetry = {
  deviceName: string;
  model: string;
  sizeBytes: number;
  diskType: string;
  systemDisk: boolean;
  readonly: boolean;
};

export type TalosHostTelemetry = {
  endpoint: string;
  nodeAddress: string;
  loadAverage: TalosLoadAverage | null;
  memory: TalosMemoryTelemetry | null;
  mounts: TalosMountTelemetry[];
  network: TalosNetworkTelemetry[];
  diskIo: TalosDiskIoTelemetry[];
  disks: TalosDiskTelemetry[];
};

export type TalosUpgradeInput = {
  image: string;
  stage: boolean;
  rebootMode: "default" | "powercycle";
};

export const EMPTY_TALOS_STATUS: TalosStatus = {
  configured: false,
  reachable: false,
  endpoint: null,
  nodeAddress: null,
  configPath: null,
  clientMode: "native",
  version: null,
  lastError: null,
};

export async function talosConnect(args: {
  endpoint: string;
  configPath: string;
}): Promise<TalosStatus> {
  if (!inTauri()) {
    return {
      ...EMPTY_TALOS_STATUS,
      lastError: "Talos API unavailable — running outside Tauri",
    };
  }
  return await invoke<TalosStatus>("talos_connect", {
    endpoint: args.endpoint,
    configPath: args.configPath,
  });
}

export async function talosStatus(): Promise<TalosStatus> {
  if (!inTauri()) return EMPTY_TALOS_STATUS;
  return await invoke<TalosStatus>("talos_status");
}

export async function talosConfigInfo(args: {
  endpoint?: string;
  configPath?: string;
} = {}): Promise<TalosConfigInfo> {
  if (!inTauri()) {
    throw new Error("talos_config_info unavailable — running outside Tauri");
  }
  recordE2eCommand("talos_config_info");
  return await invoke<TalosConfigInfo>("talos_config_info", {
    endpoint: args.endpoint ?? null,
    configPath: args.configPath ?? null,
  });
}

export async function talosTrustConfig(args: {
  endpoint?: string;
  configPath?: string;
} = {}): Promise<TalosConfigInfo> {
  if (!inTauri()) {
    throw new Error("talos_trust_config unavailable — running outside Tauri");
  }
  return await invoke<TalosConfigInfo>("talos_trust_config", {
    endpoint: args.endpoint ?? null,
    configPath: args.configPath ?? null,
  });
}

export async function talosService(service = "ext-protocore"): Promise<TalosTextResult> {
  if (!inTauri()) {
    throw new Error("talos_service unavailable — running outside Tauri");
  }
  return await invoke<TalosTextResult>("talos_service", { service });
}

export async function talosProtocoreReadiness(
  rpcEndpoint?: string | null,
): Promise<ProtocoreReadiness> {
  if (!inTauri()) {
    throw new Error("talos_protocore_readiness unavailable — running outside Tauri");
  }
  recordE2eCommand("talos_protocore_readiness");
  return await invoke<ProtocoreReadiness>("talos_protocore_readiness", {
    rpcEndpoint: rpcEndpoint ?? null,
  });
}

export async function rpcRuntimeProvenance(
  rpcEndpoint: string,
): Promise<RuntimeProvenanceResponse> {
  if (!inTauri()) {
    throw new Error("rpc_runtime_provenance unavailable — running outside Tauri");
  }
  return await invoke<RuntimeProvenanceResponse>("rpc_runtime_provenance", { rpcEndpoint });
}

export async function talosHostTelemetry(): Promise<TalosHostTelemetry> {
  if (!inTauri()) {
    throw new Error("talos_host_telemetry unavailable — running outside Tauri");
  }
  return await invoke<TalosHostTelemetry>("talos_host_telemetry");
}

export async function talosExportProtocoreBackup(): Promise<TalosBackupResult> {
  if (!inTauri()) {
    throw new Error("talos_export_protocore_backup unavailable — running outside Tauri");
  }
  return await invoke<TalosBackupResult>("talos_export_protocore_backup");
}

export async function talosOperatorSealEk(): Promise<TalosOperatorSealEkResult> {
  if (!inTauri()) {
    throw new Error("talos_operator_seal_ek unavailable — running outside Tauri");
  }
  return await invoke<TalosOperatorSealEkResult>("talos_operator_seal_ek");
}

export async function talosUpgrade(input: TalosUpgradeInput): Promise<TalosTextResult> {
  if (!inTauri()) {
    throw new Error("talos_upgrade unavailable — running outside Tauri");
  }
  recordE2eCommand(`talos_upgrade:${input.stage ? "stage" : "apply"}`);
  return await invoke<TalosTextResult>("talos_upgrade", {
    image: input.image,
    stage: input.stage,
    rebootMode: input.rebootMode,
  });
}

export async function talosRollback(): Promise<TalosTextResult> {
  if (!inTauri()) {
    throw new Error("talos_rollback unavailable — running outside Tauri");
  }
  recordE2eCommand("talos_rollback");
  return await invoke<TalosTextResult>("talos_rollback");
}

export async function talosServiceAction(
  service = "ext-protocore",
  action: "start" | "stop" | "restart",
): Promise<TalosTextResult> {
  if (!inTauri()) {
    throw new Error("talos_service_action unavailable — running outside Tauri");
  }
  recordE2eCommand(`talos_service_action:${action}`);
  return await invoke<TalosTextResult>("talos_service_action", { service, action });
}

export async function talosLogs(
  service = "ext-protocore",
  lines = 200,
): Promise<TalosTextResult> {
  if (!inTauri()) {
    throw new Error("talos_logs unavailable — running outside Tauri");
  }
  return await invoke<TalosTextResult>("talos_logs", { service, lines });
}

export async function talosLogStream(
  service = "ext-protocore",
  lines = 200,
  sessionId?: number,
): Promise<number> {
  if (!inTauri()) {
    throw new Error("talos_log_stream unavailable — running outside Tauri");
  }
  return await invoke<number>("talos_log_stream", {
    service,
    lines,
    sessionId: sessionId ?? null,
  });
}

export async function talosLogCancel(sessionId: number): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("talos_log_cancel", { sessionId });
}

// ---- streaming exec ------------------------------------------------
//
// Long-running commands (typically `journalctl -fu monod -o json`) emit
// one Tauri event per stdout line on `monarch://ssh-log/<sessionId>`.
// `sshExecStream` returns the `sessionId`, which the caller passes back
// to `sshExecCancel` on tear-down. `listenSshLog` wires both the
// per-line handler and the optional EOF handler in one call so view
// code doesn't have to track two unsubscribes.

export async function sshExecStream(cmd: string): Promise<number> {
  if (!inTauri()) {
    throw new Error("ssh_exec_stream unavailable — running outside Tauri");
  }
  return await invoke<number>("ssh_exec_stream", { cmd });
}

export async function sshExecCancel(sessionId: number): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("ssh_exec_cancel", { sessionId });
}

export async function listenTalosLog(
  sessionId: number,
  onLine: (line: string) => void,
  onEnd?: () => void,
  onError?: (message: string) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) {
    return () => {};
  }
  const lineUnlisten = await listen<string>(
    `monarch://talos-log/${sessionId}`,
    (event) => onLine(event.payload),
  );
  const endUnlisten = await listen<string>(
    `monarch://talos-log/${sessionId}/end`,
    () => onEnd?.(),
  );
  const errorUnlisten = await listen<string>(
    `monarch://talos-log/${sessionId}/error`,
    (event) => onError?.(event.payload),
  );
  return () => {
    lineUnlisten();
    endUnlisten();
    errorUnlisten();
  };
}

/**
 * Subscribe to a streaming SSH exec session. Returns a single unsubscribe
 * function that drops both the per-line and end listeners. The hook layer
 * pairs this with `sshExecCancel(sessionId)` on cleanup so the Rust task
 * stops emitting and closes its channel.
 */
export async function listenSshLog(
  sessionId: number,
  onLine: (line: string) => void,
  onEnd?: () => void,
): Promise<UnlistenFn> {
  if (!inTauri()) {
    // No-op browser shim — no local lines are fabricated.
    return () => {};
  }
  const lineUnlisten = await listen<string>(
    `monarch://ssh-log/${sessionId}`,
    (event) => onLine(event.payload),
  );
  const endUnlisten = await listen<string>(
    `monarch://ssh-log/${sessionId}/end`,
    () => onEnd?.(),
  );
  return () => {
    lineUnlisten();
    endUnlisten();
  };
}

// ---- advisory bridge ------------------------------------------------
//
// `ask_monarch` streams either a configured hosted endpoint or a local
// chat endpoint. The Rust side returns a
// `correlation_id` synchronously; tokens arrive on
// `monarch://ask/stream/<id>`, the final assembled reply + parsed
// `proposed_action` arrives on `monarch://ask/done/<id>`, and any
// fatal error arrives on `monarch://ask/error/<id>`. The React side
// listens via `listenAskStream` which folds all three channels into
// a single subscription.

export type AiProvider = "hosted" | "local";

export type AiConfig = {
  provider: AiProvider;
  hosted_url: string;
  hosted_model: string;
  local_url: string;
  local_model: string;
};

export type ProposedField = {
  key: string;
  label: string;
  value: string;
};

/// Structured intent the model can return. Shape is kept aligned with
/// the React `OpRequest` so the Ask view can hand it to the Operations
/// drawer with no translation other than a type widen on `kind`.
export type ProposedAction = {
  kind: string;
  title: string;
  sub: string;
  intro: string;
  fields?: ProposedField[];
  destructive?: boolean;
  needsPasskey?: boolean;
};

export type AskDonePayload = {
  correlation_id: number;
  text: string;
  proposed_action: ProposedAction | null;
  provider: AiProvider;
  model: string;
};

export type AskErrorPayload = {
  correlation_id: number;
  error: string;
};

export async function getAiConfig(): Promise<AiConfig> {
  if (!inTauri()) {
    return {
      provider: "local",
      hosted_url: "",
      hosted_model: "",
      local_url: "http://localhost:11434",
      local_model: "qwen2.5:3b",
    };
  }
  return await invoke<AiConfig>("get_ai_config");
}

export async function setAiConfig(cfg: AiConfig): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("set_ai_config", { cfg });
}

/**
 * Kick off one Ask Monarch round. Returns the correlation id that the
 * Tauri side stamps on the `monarch://ask/stream/<id>` and
 * `monarch://ask/done/<id>` events.
 */
export async function askMonarch(prompt: string): Promise<number> {
  if (!inTauri()) {
    throw new Error("ask_monarch unavailable — running outside Tauri");
  }
  return await invoke<number>("ask_monarch", { req: { prompt } });
}

/**
 * Subscribe to an in-flight ask round. Three optional handlers:
 *   * `onChunk(text)` — every model token delta as it arrives.
 *   * `onDone(payload)` — the assembled text + parsed proposed action.
 *   * `onError(payload)` — fatal provider error (missing key, http, ...).
 * Returns a single unsubscribe function that drops all three listeners.
 */
export async function listenAskStream(
  correlationId: number,
  handlers: {
    onChunk?: (text: string) => void;
    onDone?: (payload: AskDonePayload) => void;
    onError?: (payload: AskErrorPayload) => void;
  },
): Promise<UnlistenFn> {
  if (!inTauri() || correlationId < 0) {
    return () => {};
  }
  const chunkUnlisten = await listen<string>(
    `monarch://ask/stream/${correlationId}`,
    (event) => handlers.onChunk?.(event.payload),
  );
  const doneUnlisten = await listen<AskDonePayload>(
    `monarch://ask/done/${correlationId}`,
    (event) => handlers.onDone?.(event.payload),
  );
  const errorUnlisten = await listen<AskErrorPayload>(
    `monarch://ask/error/${correlationId}`,
    (event) => handlers.onError?.(event.payload),
  );
  return () => {
    chunkUnlisten();
    doneUnlisten();
    errorUnlisten();
  };
}

// ---- operator chat (Phase 1 MVP) ----------------------------------
//
// The Rust `chat` module runs a minimal libp2p gossipsub node, signs
// every message with the operator's existing PQM-1 (ML-DSA-65) key from
// the keychain, and persists a local SQLite history. Cluster status is
// read live from the node-registry (`lyth_clusterStatus`), every runtime
// join/send/inbound persist resolves `lyth_operatorInfo` for the active
// roster, and messages fail closed unless the signed sender address
// belongs to that cluster. Release e2e evidence records the same proof
// for every signed sender. Inbound messages arrive on
// `monarch://chat/message/{channel_id}`; `listenChatMessages` subscribes
// the live tail. Outside Tauri every helper resolves to an empty unavailable
// state so the `pnpm dev` preview renders without fabricated messages.
//
// Deferred beyond the current cluster-channel release: DMs, challenge-sign
// login, backfill, attachments, reactions, and E2E encryption.

export type { ChatChannel, ChatInitResult, ChatMessage } from "./chat";

/**
 * Initialize the chat subsystem on app mount. Derives the operator
 * identity from the keychain mnemonic and spawns the gossipsub swarm.
 * `bootstrapPeers` are libp2p multiaddrs resolved from local config and,
 * when the live roster exposes explicit chat metadata, operator network
 * metadata. `rpcEndpoint` overrides the membership-read endpoint. Returns
 * null outside Tauri or when the operator mnemonic isn't stored yet (the
 * UI then prompts the operator to add their key).
 */
export async function chatInitialize(args?: {
  rpcEndpoint?: string;
  bootstrapPeers?: string[];
}): Promise<ChatInitResult | null> {
  if (!inTauri()) return null;
  try {
    recordE2eCommand("chat_initialize");
    return await invoke<ChatInitResult>("chat_initialize", {
      rpcEndpoint: args?.rpcEndpoint ?? null,
      bootstrapPeers: args?.bootstrapPeers ?? null,
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    // Missing operator key is an expected pre-setup state, not a crash.
    if (/mnemonic not in keychain/i.test(msg)) return null;
    throw err;
  }
}

export async function chatGetChannels(): Promise<ChatChannel[]> {
  if (!inTauri()) return [];
  return await invoke<ChatChannel[]>("chat_get_channels");
}

export async function chatGetMessages(
  channelId: string,
  limit?: number,
): Promise<ChatMessage[]> {
  if (!inTauri()) return [];
  return await invoke<ChatMessage[]>("chat_get_messages", {
    channelId,
    limit: limit ?? null,
  });
}

/** Join a cluster channel after a live membership check. */
export async function chatSubscribeChannel(args: {
  clusterId: number;
  name?: string;
}): Promise<ChatChannel> {
  if (!inTauri()) {
    throw new Error("chat_subscribe_channel unavailable — running outside Tauri");
  }
  recordE2eCommand("chat_subscribe_channel");
  return await invoke<ChatChannel>("chat_subscribe_channel", {
    clusterId: args.clusterId,
    name: args.name ?? null,
  });
}

export async function chatUnsubscribeChannel(channelId: string): Promise<void> {
  if (!inTauri()) return;
  await invoke<void>("chat_unsubscribe_channel", { channelId });
}

/** Sign + publish a message. Returns the optimistic local record. */
export async function chatSendMessage(args: {
  channelId: string;
  clusterId: number;
  body: string;
}): Promise<ChatMessage> {
  if (!inTauri()) {
    throw new Error("chat_send_message unavailable — running outside Tauri");
  }
  recordE2eCommand("chat_send_message");
  return await invoke<ChatMessage>("chat_send_message", {
    channelId: args.channelId,
    clusterId: args.clusterId,
    body: args.body,
  });
}

/**
 * Subscribe to the live message tail for one channel. The Rust side
 * emits a `MessageRecord` on `monarch://chat/message/{channelId}` for
 * every locally-sent message and every verified inbound gossip message.
 * Returns a single unsubscribe function.
 */
export async function listenChatMessages(
  channelId: string,
  onMessage: (message: ChatMessage) => void,
): Promise<UnlistenFn> {
  if (!inTauri()) {
    return () => {};
  }
  return await listen<ChatMessage>(
    `monarch://chat/message/${channelId}`,
    (event) => onMessage(event.payload),
  );
}
