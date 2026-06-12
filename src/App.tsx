// Full chrome + design-route shell. Operations drawer mounted at
// the app root so any view can request operations through the shared
// OpsProvider context. SDK-driven node status flows through the TopBar
// (live round/block halo). ⌘K palette and `g+letter` nav are wired here
// so they work on every route.

import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useLayoutEffect,
  useState,
  type ComponentType,
} from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { SideNav } from "./components/SideNav";
import { TopBar } from "./components/TopBar";
import { AskBar } from "./components/AskBar";
import { AskRail } from "./components/AskRail";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TweaksPanel, useTweaks } from "./components/TweaksPanel";
import { UpdateBanner } from "./components/UpdateBanner";
import { checkForUpdate, type UpdateAvailable } from "./sdk/updater";
import { rpcEndpoint } from "./sdk/client";
import { resolveChatBootstrapPeersForCluster } from "./sdk/chatConfig";
import { chatInitialize, inTauri } from "./sdk/bridge";
import { DEFAULT_ACTIVE_CLUSTER_ID } from "./sdk/clusterModel";
import { collectMonarchE2eReadiness } from "./sdk/e2eReadinessCollector";
import { installMonarchE2eRecorder, recordE2eRoute } from "./sdk/e2eRecorder";
import { OperationsDrawer, OpsProvider, useOps } from "./ops";
import { NAV_ROUTES, useNavKeys } from "./nav";
import { CommandPalette } from "./palette/CommandPalette";
import { Home } from "./views/Home";
import { Operator } from "./views/Operator";
import { Cluster } from "./views/Cluster";
import { Operations } from "./views/Operations";
import { Metrics } from "./views/Metrics";
import { Logs } from "./views/Logs";
import { Welcome } from "./views/Welcome";
import { Setup } from "./views/Setup";
import { quickConfiguredProbe } from "./sdk/onboarding";

// Code-split the heavier, less-trafficked surfaces: the eleven design
// routes share one lazy chunk; Chat / Install / Hardware each get their
// own. Core operator surfaces (Home, Operator, Cluster, Operations,
// Metrics, Logs) stay eager so first paint never waits on a fetch.
const Chat = lazy(() => import("./views/Chat").then((m) => ({ default: m.Chat })));
const Install = lazy(() => import("./views/Install").then((m) => ({ default: m.Install })));
const Hardware = lazy(() => import("./views/Hardware").then((m) => ({ default: m.Hardware })));
const Marketplace = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Marketplace })));
const Services = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Services })));
const Audit = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Audit })));
const Governance = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Governance })));
const Alerts = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Alerts })));
const Wallets = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Wallets })));
const SetupOperator = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.SetupOperator })));
const SetupCluster = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.SetupCluster })));
const Attestation = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Attestation })));
const Keys = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Keys })));
const Recovery = lazy(() => import("./views/DesignRoutes").then((m) => ({ default: m.Recovery })));

// Glass skeleton shown while a lazy route chunk loads.
function RouteSkeleton() {
  return (
    <section className="view fade-in lv-skel" aria-busy="true" aria-label="Loading view">
      <div className="lv-skel__bar" />
      <div className="lv-skel__row">
        <div className="lv-skel__card" />
        <div className="lv-skel__card" />
        <div className="lv-skel__card" />
      </div>
      <div className="lv-skel__row">
        <div className="lv-skel__card" />
        <div className="lv-skel__card" />
      </div>
    </section>
  );
}

const VIEW_KEY = "monarch:view";

// First-run gate: instead of dropping a fresh operator on a dashboard
// of em-dashes, probe whether ANYTHING is configured (operator key /
// Talos / SSH — bounded to ~1.2s). Nothing configured → the /setup
// wizard (node-connect first); otherwise restore the last view as before.
function LastViewRedirect() {
  const [target, setTarget] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void quickConfiguredProbe()
      .catch(() => false)
      .then((configured) => {
        if (cancelled) return;
        if (!configured) {
          setTarget("/setup");
          return;
        }
        const saved =
          typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
        setTarget(saved && NAV_ROUTES.some((r) => r.path === saved) ? saved : "/home");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!target) return null;
  return <Navigate to={target} replace />;
}

// /ceremony resolves the CeremonyRoom view if it exists in the build
// (it ships from a parallel workstream). When the file is absent — or
// fails to load — the route gracefully falls back to a guided
// placeholder, so this build stays green standalone.
const ceremonyModules = import.meta.glob("./views/CeremonyRoom.tsx") as Record<
  string,
  () => Promise<unknown>
>;

function CeremonyComingSoon() {
  const navigate = useNavigate();
  return (
    <section className="view fade-in">
      <header>
        <h1 className="view__title">Ceremony</h1>
        <p className="view__subtitle">
          live multi-party cluster-formation lobby · landing in an upcoming build
        </p>
      </header>
      <div className="card card--padded" style={{ maxWidth: 720 }}>
        <div className="card__head">
          <div>
            <h3>The ceremony room is not in this build yet</h3>
            <div className="sub">
              It will let 10 operators gather, agree a roster, and exchange consent
              signatures live over operator chat.
            </div>
          </div>
        </div>
        <p style={{ fontSize: 12.5, color: "var(--fg-300)", lineHeight: 1.55 }}>
          Until it lands, you can still form a cluster the manual way: collect the 10
          consensus pubkeys and consent signatures out-of-band, then use the roster builder
          in Set up cluster. To be ready for the ceremony room, publish your chat peers so
          other operators can reach you.
        </p>
        <div className="inline-actions" style={{ marginTop: 12 }}>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => navigate("/setup-cluster")}
          >
            Open Set up cluster
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => navigate("/operations")}
          >
            Publish chat peers
          </button>
        </div>
      </div>
    </section>
  );
}

const CeremonyRoute = lazy(async () => {
  const load = ceremonyModules["./views/CeremonyRoom.tsx"];
  if (!load) return { default: CeremonyComingSoon };
  try {
    const mod = (await load()) as {
      default?: ComponentType;
      CeremonyRoom?: ComponentType;
    };
    return { default: mod.CeremonyRoom ?? mod.default ?? CeremonyComingSoon };
  } catch {
    return { default: CeremonyComingSoon };
  }
});

function ShellInner() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tweaksOpen, setTweaksOpen] = useState(false);
  const [tweaks, setTweaks] = useTweaks();
  const ops = useOps();
  const location = useLocation();
  // Pending self-update, if the launch-time check found one. Banner
  // renders only when set; dismissal clears it until the next launch.
  const [pendingUpdate, setPendingUpdate] = useState<UpdateAvailable | null>(null);

  useLayoutEffect(() => {
    installMonarchE2eRecorder({
      collectReadiness: collectMonarchE2eReadiness,
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((result) => {
      if (cancelled || !result.available) return;
      setPendingUpdate(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Bring up the operator chat subsystem once per launch: derive the
  // signing identity from the keychain operator key and start the
  // gossipsub swarm. Resolves to null (a no-op) outside Tauri or when
  // the operator mnemonic isn't stored yet — the Chat view then prompts
  // the operator to add their key. Failures are non-fatal: chat is a
  // non-blocking parallel surface and must never wedge the shell.
  useEffect(() => {
    if (!inTauri()) return;
    void (async () => {
      const bootstrapPeers = await resolveChatBootstrapPeersForCluster({
        endpoint: rpcEndpoint,
        clusterId: DEFAULT_ACTIVE_CLUSTER_ID,
      });
      await chatInitialize({
        rpcEndpoint,
        bootstrapPeers,
      });
    })().catch(() => undefined);
  }, []);

  // `g+letter` nav — paused while the palette is open so `g` doesn't
  // arm chord state inside the cmdk input.
  useNavKeys(paletteOpen || tweaksOpen);

  useEffect(() => {
    if (!NAV_ROUTES.some((r) => r.path === location.pathname)) return;
    recordE2eRoute(location.pathname);
    localStorage.setItem(VIEW_KEY, location.pathname);
  }, [location.pathname]);

  // Global ⌘K / Ctrl+K. Skipped when an editable target has focus, so
  // typing in the AskBar never triggers it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      setPaletteOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string } | null;
      if (data?.type === "__activate_edit_mode") setTweaksOpen(true);
      if (data?.type === "__deactivate_edit_mode") setTweaksOpen(false);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (paletteOpen) {
        setPaletteOpen(false);
        return;
      }
      if (ops.open) {
        ops.cancel();
        return;
      }
      if (tweaksOpen) {
        setTweaksOpen(false);
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [ops, paletteOpen, tweaksOpen]);

  const openPalette = useCallback(() => setPaletteOpen(true), []);

  return (
    <>
      <div className="monarch-shell">
        <div className="bg" aria-hidden="true"><div className="bg__canvas"/><div className="bg__bloom bg__bloom--a"/><div className="bg__bloom bg__bloom--b"/><div className="bg__bloom bg__bloom--c"/><div className="bg__grid"/><div className="bg__grain"/><div className="bg__vignette"/></div>
        <SideNav />
        <div className="monarch-main">
          <TopBar
            onOpenPalette={openPalette}
            onOpenTweaks={() => setTweaksOpen((prev) => !prev)}
          />
          <main className="monarch-content">
            <ErrorBoundary resetKey={location.pathname}>
              <Suspense fallback={<RouteSkeleton />}>
                <Routes>
                  <Route path="/" element={<LastViewRedirect />} />
                  <Route path="/home" element={<Home />} />
                  <Route path="/operator" element={<Operator />} />
                  <Route path="/cluster" element={<Cluster />} />
                  <Route path="/operations" element={<Operations />} />
                  <Route path="/metrics" element={<Metrics />} />
                  <Route path="/hardware" element={<Hardware />} />
                  <Route path="/logs" element={<Logs />} />
                  <Route path="/chat" element={<Chat />} />
                  <Route
                    path="/ceremony"
                    element={
                      <Suspense
                        fallback={
                          <section className="view fade-in">
                            <div className="empty-state">Loading the ceremony room…</div>
                          </section>
                        }
                      >
                        <CeremonyRoute />
                      </Suspense>
                    }
                  />
                  <Route path="/setup" element={<Setup />} />
                  <Route path="/welcome" element={<Welcome />} />
                  <Route path="/install" element={<Install />} />
                  <Route path="/marketplace" element={<Marketplace />} />
                  <Route path="/services" element={<Services />} />
                  <Route path="/audit" element={<Audit />} />
                  <Route path="/governance" element={<Governance />} />
                  <Route path="/alerts" element={<Alerts />} />
                  <Route path="/wallets" element={<Wallets />} />
                  <Route path="/setup-operator" element={<SetupOperator />} />
                  <Route path="/setup-cluster" element={<SetupCluster />} />
                  <Route path="/attestation" element={<Attestation />} />
                  <Route path="/keys" element={<Keys />} />
                  <Route path="/recovery" element={<Recovery />} />
                  <Route path="*" element={<Navigate to="/home" replace />} />
                </Routes>
              </Suspense>
            </ErrorBoundary>
          </main>
          <AskBar />
        </div>
        <OperationsDrawer />
        <AskRail />
        <TweaksPanel
          open={tweaksOpen}
          tweaks={tweaks}
          setTweaks={setTweaks}
          onClose={() => setTweaksOpen(false)}
        />
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      {pendingUpdate ? (
        <UpdateBanner
          update={pendingUpdate}
          onDismiss={() => setPendingUpdate(null)}
        />
      ) : null}
    </>
  );
}

export function App() {
  return (
    <OpsProvider>
      <ShellInner />
    </OpsProvider>
  );
}
