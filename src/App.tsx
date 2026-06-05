// Full chrome + design-route shell. Operations drawer mounted at
// the app root so any view can request operations through the shared
// OpsProvider context. SDK-driven node status flows through the TopBar
// (live round/block halo). ⌘K palette and `g+letter` nav are wired here
// so they work on every route.

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { SideNav } from "./components/SideNav";
import { TopBar } from "./components/TopBar";
import { AskBar } from "./components/AskBar";
import { AskRail } from "./components/AskRail";
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
import { Hardware } from "./views/Hardware";
import { Logs } from "./views/Logs";
import { Install } from "./views/Install";
import { Chat } from "./views/Chat";
import {
  Alerts,
  Attestation,
  Audit,
  Governance,
  Keys,
  Marketplace,
  Recovery,
  Services,
  SetupCluster,
  SetupOperator,
  Wallets,
} from "./views/DesignRoutes";

const VIEW_KEY = "monarch:view";

function LastViewRedirect() {
  const saved =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(VIEW_KEY)
      : null;
  const target = saved && NAV_ROUTES.some((r) => r.path === saved) ? saved : "/home";
  return <Navigate to={target} replace />;
}

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
        <SideNav />
        <div className="monarch-main">
          <TopBar
            onOpenPalette={openPalette}
            onOpenTweaks={() => setTweaksOpen((prev) => !prev)}
          />
          <main className="monarch-content">
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
