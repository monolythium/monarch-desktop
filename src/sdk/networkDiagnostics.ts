import { isNoSessionError, sshExec } from "./bridge";

export type NetworkDiagnosticKind = "ping" | "traceroute";

export type NetworkDiagnosticResult = {
  kind: NetworkDiagnosticKind;
  target: string;
  output: string;
  ran: boolean;
  preview: boolean;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function notRun(kind: NetworkDiagnosticKind, target: string): NetworkDiagnosticResult {
  return {
    kind,
    target,
    output:
      "Network diagnostic not run: no active SSH session or Monarch OS telemetry channel is connected.",
    ran: false,
    preview: false,
  };
}

export async function runNetworkDiagnostic(
  kind: NetworkDiagnosticKind,
  target: string,
): Promise<NetworkDiagnosticResult> {
  const cleanTarget = target.trim();
  if (!cleanTarget) {
    throw new Error("network diagnostic target is required");
  }

  const quoted = shellQuote(cleanTarget);
  const cmd =
    kind === "ping"
      ? `ping -c 8 -W 1 ${quoted} 2>&1 || true`
      : `traceroute -m 12 -w 1 ${quoted} 2>&1 || tracepath ${quoted} 2>&1 || ping -c 4 -W 1 ${quoted} 2>&1 || true`;

  try {
    const output = await sshExec(cmd);
    return {
      kind,
      target: cleanTarget,
      output: output.trim() || "(diagnostic command returned no output)",
      ran: true,
      preview: false,
    };
  } catch (err) {
    if (isNoSessionError(err)) {
      return notRun(kind, cleanTarget);
    }
    throw err;
  }
}
