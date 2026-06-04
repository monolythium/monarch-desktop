export type MonarchE2eSnapshot = {
  routesVisited: string[];
  commandsObserved: string[];
  windowsObserved: number;
};

export type MonarchE2eReadinessCollector = (
  options?: unknown,
) => Promise<unknown>;

type MonarchE2eGlobal = {
  snapshot: () => MonarchE2eSnapshot;
  recordRoute: (route: string) => void;
  recordCommand: (command: string) => void;
  setWindowsObserved: (count: number) => void;
  collectReadiness?: MonarchE2eReadinessCollector;
};

declare global {
  interface Window {
    __MONARCH_E2E__?: MonarchE2eGlobal;
  }
}

const enabled = import.meta.env.VITE_MONARCH_E2E_RECORDER === "true";
const routes = new Set<string>();
const commands: string[] = [];
let windowsObserved = 1;
let readinessCollector: MonarchE2eReadinessCollector | null = null;

export function installMonarchE2eRecorder(args: {
  collectReadiness?: MonarchE2eReadinessCollector;
} = {}): void {
  if (!enabled || typeof window === "undefined") return;
  readinessCollector = args.collectReadiness ?? readinessCollector;
  window.__MONARCH_E2E__ = {
    snapshot: e2eSnapshot,
    recordRoute: recordE2eRoute,
    recordCommand: recordE2eCommand,
    setWindowsObserved: setE2eWindowsObserved,
    collectReadiness: readinessCollector ?? undefined,
  };
}

export function recordE2eRoute(route: string): void {
  if (!enabled) return;
  const normalized = normalizeRoute(route);
  if (normalized) routes.add(normalized);
}

export function recordE2eCommand(command: string): void {
  if (!enabled) return;
  const normalized = command.trim();
  if (normalized && !commands.includes(normalized)) {
    commands.push(normalized);
  }
}

export function setE2eWindowsObserved(count: number): void {
  if (!enabled || !Number.isFinite(count)) return;
  windowsObserved = Math.max(windowsObserved, Math.trunc(count));
}

export function e2eSnapshot(): MonarchE2eSnapshot {
  return {
    routesVisited: Array.from(routes).sort(),
    commandsObserved: [...commands],
    windowsObserved,
  };
}

function normalizeRoute(route: string): string {
  const trimmed = route.trim();
  if (!trimmed) return "";
  return trimmed === "/" ? "/home" : trimmed;
}
