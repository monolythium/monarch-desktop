import { OP_CATALOG } from "../ops/catalog";
import type { OpKind } from "../ops/types";

export const DESIGN_ROUTE_IDS = [
  "home",
  "operator",
  "cluster",
  "marketplace",
  "chat",
  "hardware",
  "operations",
  "services",
  "metrics",
  "logs",
  "audit",
  "governance",
  "alerts",
  "wallets",
  "install",
  "setup-operator",
  "setup-cluster",
  "attestation",
  "keys",
  "recovery",
] as const;

export const DESIGN_ROUTE_PATHS = DESIGN_ROUTE_IDS.map((id) => `/${id}`);

export const DESIGN_OPERATION_IDS = [
  "reboot-os",
  "apply-ota",
  "wipe-chain-data",
  "toggle-autostart",
  "rotate-cluster-share",
  "rotate-admin-passkey",
  "rotate-bridge-ed25519",
  "backup-keys",
  "recover-account-key",
  "import-validator-key",
  "post-bond-topup",
  "delegate-stake",
  "unbond-stake",
  "claim-rewards",
  "enable-private-receive",
  "burn-private",
  "unjail-cluster",
  "accept-cluster-invite",
  "invite-operator",
  "vouch-peer-recovery",
  "eject-replace-operator",
  "toggle-service-role",
  "expose-endpoints",
  "sync-firewall",
  "init-sentry",
  "refresh-peers",
  "edit-env-var",
  "sign-governance-memo",
  "submit-proposal",
  "emergency-halt-share",
  "restore-foundation",
] as const;

type DesignOperationId = (typeof DESIGN_OPERATION_IDS)[number];

type ImplementedDesignOperation = {
  status: "implemented";
  kind: OpKind;
  note: string;
};

type DeferredDesignOperation = {
  status: "deferred";
  reason: string;
  relatedKind?: OpKind;
};

export type DesignOperationParity =
  | ImplementedDesignOperation
  | DeferredDesignOperation;

export const DESIGN_OPERATION_PARITY = {
  "reboot-os": {
    status: "deferred",
    reason:
      "The design asks for full OS reboot. Desktop currently exposes service start/stop/restart only.",
    relatedKind: "operator-restart",
  },
  "apply-ota": {
    status: "implemented",
    kind: "ota-apply",
    note: "Talos upgrade RPC with preserve=true enforcement.",
  },
  "wipe-chain-data": {
    status: "deferred",
    reason:
      "No audited Talos/protocore data-wipe executor exists in Desktop yet.",
  },
  "toggle-autostart": {
    status: "deferred",
    reason:
      "No service autostart policy operation is exposed by the current Talos bridge.",
  },
  "rotate-cluster-share": {
    status: "implemented",
    kind: "rotate-keys",
    note: "Current chain path is the DKG reshare attestation operation.",
  },
  "rotate-admin-passkey": {
    status: "deferred",
    reason:
      "Passkey enrollment and rotation need a dedicated local credential store plus on-chain binding.",
  },
  "rotate-bridge-ed25519": {
    status: "deferred",
    reason:
      "Bridge compatibility key rotation has no Desktop operation or SDK executor yet.",
  },
  "backup-keys": {
    status: "implemented",
    kind: "export-backup",
    note: "Offline /var/lib/protocore export through the Talos Copy API.",
  },
  "recover-account-key": {
    status: "deferred",
    reason:
      "Account-key recovery is not wired to the current keychain or wallet runtime.",
  },
  "import-validator-key": {
    status: "deferred",
    reason:
      "Legacy design flow; the target product flow is first-boot operator key generation, not key import.",
  },
  "post-bond-topup": {
    status: "deferred",
    reason:
      "Self-bond top-up needs a chain operation separate from initial operator registration.",
  },
  "delegate-stake": {
    status: "deferred",
    reason:
      "Desktop has redelegation, but initial delegation is not implemented as a distinct operation.",
    relatedKind: "redelegate",
  },
  "unbond-stake": {
    status: "deferred",
    reason: "Unbonding is not exposed by the current operation catalog.",
  },
  "claim-rewards": {
    status: "deferred",
    reason: "Reward claiming is not exposed by the current operation catalog.",
  },
  "enable-private-receive": {
    status: "deferred",
    reason:
      "Private receive policy requires wallet/privacy-chain support that Desktop does not currently expose.",
  },
  "burn-private": {
    status: "deferred",
    reason:
      "Private burn requires wallet/privacy-chain support that Desktop does not currently expose.",
  },
  "unjail-cluster": {
    status: "deferred",
    reason:
      "Design calls for cluster-threshold unjail; current restore path is foundation-gated recovery.",
    relatedKind: "operator-restore",
  },
  "accept-cluster-invite": {
    status: "implemented",
    kind: "cluster-accept-invite",
    note: "Foundation Add pending-change path retained until CJ-1 is live.",
  },
  "invite-operator": {
    status: "deferred",
    reason:
      "Replaced by CJ-1 request/vote preparation; execution waits for the live CJ-1 runtime and SDK package.",
    relatedKind: "cluster-vote-admit",
  },
  "vouch-peer-recovery": {
    status: "deferred",
    reason:
      "Peer-vouched recovery needs an on-chain recovery primitive and cluster-member signing flow.",
  },
  "eject-replace-operator": {
    status: "deferred",
    reason:
      "Current cluster swap is foundation-coordinated; design requires cluster-threshold eject/replace semantics.",
    relatedKind: "cluster-swap",
  },
  "toggle-service-role": {
    status: "deferred",
    reason:
      "Service-role enablement needs a chain/API surface instead of local-only toggles.",
  },
  "expose-endpoints": {
    status: "deferred",
    reason:
      "Endpoint exposure needs Talos machine-config and firewall preview/apply support.",
  },
  "sync-firewall": {
    status: "deferred",
    reason:
      "Firewall sync needs Talos machine-config diff/apply support in the bridge.",
  },
  "init-sentry": {
    status: "deferred",
    reason: "Sentry topology setup is not exposed by the current Talos bridge.",
  },
  "refresh-peers": {
    status: "deferred",
    reason:
      "Peer refresh is read-only/discovery today; there is no signed refresh operation.",
  },
  "edit-env-var": {
    status: "deferred",
    reason:
      "Direct env editing is intentionally not exposed; any future flow must be machine-config diff based.",
  },
  "sign-governance-memo": {
    status: "deferred",
    reason:
      "Governance memo signing is not exposed by the current SDK/Desktop operation path.",
  },
  "submit-proposal": {
    status: "deferred",
    reason:
      "Proposal submission is not exposed by the current SDK/Desktop operation path.",
  },
  "emergency-halt-share": {
    status: "deferred",
    reason:
      "Emergency self-halt needs a dedicated chain operation and risk policy.",
  },
  "restore-foundation": {
    status: "implemented",
    kind: "operator-restore",
    note: "Foundation operations signer submits recoverOperatorNode(bytes32).",
  },
} satisfies Record<DesignOperationId, DesignOperationParity>;

export const CATALOG_PRODUCT_EXTENSION_KINDS = [
  "operator-register",
  "operator-start",
  "operator-stop",
  "operator-display",
  "chat-bootstrap-peers",
  "cluster-name-register",
  "cluster-form",
  "cluster-request-join",
  "cluster-vote-admit",
  "freeze-admission",
  "emergency-key-rotation",
  "ota-rollback",
] satisfies ReadonlyArray<OpKind>;

export type DesignAuditStatus =
  | "implemented"
  | "partial"
  | "deferred"
  | "superseded"
  | "external";

export type DesignAuditDomain =
  | "desktop-shell"
  | "operator-console"
  | "cluster-marketplace"
  | "node-service"
  | "setup"
  | "treasury-wallet"
  | "chat"
  | "monoscan"
  | "browser-extension"
  | "mobile-wallet"
  | "public-site"
  | "studio-tooling"
  | "shared-data";

export type DesignSourceAuditEntry = {
  file: string;
  domain: DesignAuditDomain;
  status: DesignAuditStatus;
  desktopSurface: string;
  evidence: string;
  decision: string;
  routes?: readonly string[];
  operationKinds?: readonly OpKind[];
  runtimePrereq?: string;
};

export const DESIGN_SOURCE_AUDIT = [
  {
    file: "alerts.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/alerts",
    routes: ["/alerts"],
    evidence: "Implemented as a design route backed by live/readiness alert state where SDK hooks expose it.",
    decision: "Keep route shell; deeper alert-rule editing waits for a chain/API policy surface.",
  },
  {
    file: "app.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "App shell, route registry, command palette, tweaks panel",
    routes: DESIGN_ROUTE_PATHS,
    evidence: "App.tsx, NAV_ROUTES, CommandPalette, useNavKeys, and TweaksPanel implement the core shell.",
    decision: "Sidebar shell is implemented; alternate top/dock studio layouts remain design-only.",
  },
  {
    file: "ask.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "AskBar and AskRail",
    evidence: "AskBar, AskRail, and palette Ask queries are mounted globally.",
    decision: "Local advisory surface exists; richer design answer cards require model/tool policy.",
  },
  {
    file: "attestation.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/attestation",
    routes: ["/attestation"],
    evidence: "Attestation design route and release-attestation SDK helpers are implemented.",
    decision: "Runtime-backed attestation depends on OS smoke/release evidence being supplied.",
  },
  {
    file: "audit.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/audit",
    routes: ["/audit"],
    evidence: "Audit route and operation receipts exist.",
    decision: "Full audit explorer waits for complete receipt retention/query UX.",
  },
  {
    file: "chat-data.jsx",
    domain: "chat",
    status: "partial",
    desktopSurface: "Chat bootstrap and local chat state",
    evidence: "Chat view, chat hooks, and chat peer operations are implemented with release e2e coverage.",
    decision: "Design sample data is replaced by live/libp2p bootstrap metadata where available.",
  },
  {
    file: "chat.jsx",
    domain: "chat",
    status: "partial",
    desktopSurface: "/chat",
    routes: ["/chat"],
    operationKinds: ["chat-bootstrap-peers"],
    evidence: "Chat route, signed chat peer metadata op, and release e2e readiness hooks exist.",
    decision: "Live cluster chat still depends on configured bootstrap peers and operator keys.",
  },
  {
    file: "chrome.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "SideNav, TopBar, global chrome",
    evidence: "SideNav, TopBar, AskBar, AskRail, UpdateBanner, and OperationsDrawer are mounted.",
    decision: "Implemented route/chrome behavior; studio-only alternate chrome variants remain deferred.",
  },
  {
    file: "cluster.jsx",
    domain: "cluster-marketplace",
    status: "partial",
    desktopSurface: "/cluster",
    routes: ["/cluster"],
    operationKinds: [
      "cluster-name-register",
      "cluster-form",
      "cluster-request-join",
      "cluster-vote-admit",
      "cluster-accept-invite",
      "cluster-swap",
    ],
    runtimePrereq: "CJ-1/formCluster runtime deployment for live request/vote/formation success.",
    evidence: "Cluster route reads cluster status, provider directory, diversity, resignations, cluster names, and cluster request/vote/form prep operations.",
    decision: "Browse and guarded request/vote/form submit paths exist; incompatible runtimes fail before broadcast where preflight is available.",
  },
  {
    file: "data.jsx",
    domain: "shared-data",
    status: "partial",
    desktopSurface: "SDK hooks, route fixtures, operation catalog",
    evidence: "Static design data has been replaced by SDK reads and OP_CATALOG where backend support exists.",
    decision: "Design constants are not imported at runtime; this file is audited as product intent.",
  },
  {
    file: "ext-app.jsx",
    domain: "browser-extension",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "No extension runtime lives in this repo.",
    decision: "Track in browser wallet/extension work; Desktop only needs compatible wallet connect policy.",
  },
  {
    file: "ext-chrome.jsx",
    domain: "browser-extension",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "No extension popup/chrome app is built by this repo.",
    decision: "Out of Desktop scope for W7.",
  },
  {
    file: "ext-data.jsx",
    domain: "browser-extension",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "No extension data model is consumed by Desktop.",
    decision: "Out of Desktop scope for W7.",
  },
  {
    file: "ext-popup.jsx",
    domain: "browser-extension",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "No extension popup route exists in Desktop.",
    decision: "Out of Desktop scope for W7.",
  },
  {
    file: "ext-requests.jsx",
    domain: "browser-extension",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Desktop operation drawer is separate from browser dApp request dialogs.",
    decision: "Out of Desktop scope for W7.",
  },
  {
    file: "governance.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/governance",
    routes: ["/governance"],
    evidence: "Governance route exists as a design route.",
    decision: "Proposal submission/memo signing remains deferred until SDK/runtime support exists.",
  },
  {
    file: "hardware.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/hardware",
    routes: ["/hardware"],
    evidence: "Hardware route uses Talos status/service/readiness hooks.",
    decision: "Machine config mutation remains deferred behind audited Talos diff/apply support.",
  },
  {
    file: "home.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/home",
    routes: ["/home"],
    evidence: "Home route reads chain, cluster, operator-risk, signing activity, and upcoming duties where exposed.",
    decision: "Live values fail closed or show unavailable states when RPC methods are absent.",
  },
  {
    file: "install.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/install",
    routes: ["/install"],
    evidence: "Install route and Talos settings surfaces exist.",
    decision: "Desktop pairs with an existing node; OS flashing/provisioning remains outside Desktop.",
  },
  {
    file: "keys.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/keys and OperatorKeySettings",
    routes: ["/keys"],
    evidence: "Operator PQM-1 key import/validation and derived ML-DSA register path exist.",
    decision: "Desktop imports operator keys; OS first boot owns node key generation.",
  },
  {
    file: "logs.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/logs",
    routes: ["/logs"],
    evidence: "Logs route and Talos service log streaming hooks exist.",
    decision: "Advanced filtering/export remains future polish.",
  },
  {
    file: "marketplace.jsx",
    domain: "cluster-marketplace",
    status: "partial",
    desktopSurface: "/marketplace",
    routes: ["/marketplace"],
    operationKinds: ["cluster-request-join"],
    runtimePrereq: "CJ-1 runtime for live join requests.",
    evidence: "Marketplace route and provider/cluster directory reads are wired.",
    decision: "Read-side marketplace exists; live join execution waits for W4/W5.",
  },
  {
    file: "metrics.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/metrics",
    routes: ["/metrics"],
    evidence: "Metrics route uses chain/operator telemetry helpers where exposed.",
    decision: "Prometheus/Grafana deep links are not a separate Desktop operation yet.",
  },
  {
    file: "monoscan-app.jsx",
    domain: "monoscan",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Monoscan is a separate explorer surface, not a Desktop route.",
    decision: "Track in Monoscan repo; Desktop may deep-link later.",
  },
  {
    file: "monoscan-data.jsx",
    domain: "monoscan",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Explorer data is not consumed by Desktop.",
    decision: "Track in Monoscan repo.",
  },
  {
    file: "monoscan-extras.jsx",
    domain: "monoscan",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Explorer extras are not Desktop features.",
    decision: "Track in Monoscan repo.",
  },
  {
    file: "monoscan-markets.jsx",
    domain: "monoscan",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Market explorer surfaces are not Desktop operator-console surfaces.",
    decision: "Track in Monoscan/markets work.",
  },
  {
    file: "monoscan-theme.jsx",
    domain: "monoscan",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Explorer theme controls are not used by Desktop.",
    decision: "Track in Monoscan repo.",
  },
  {
    file: "operations.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/operations and OperationsDrawer",
    routes: ["/operations"],
    operationKinds: OP_CATALOG.map((entry) => entry.kind),
    evidence: "Operations route, drawer state machine, catalog, command palette, and focused form tests exist.",
    decision: "Every design operation is mapped to an implemented operation or explicit deferral.",
  },
  {
    file: "operator.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/operator",
    routes: ["/operator"],
    operationKinds: ["operator-register", "operator-display", "operator-start", "operator-stop", "operator-restart"],
    evidence: "Operator route reads node/operator state and exposes register/display/service operations.",
    decision: "Live operator identity generation happens on OS first boot; Desktop imports the operator PQM-1 mnemonic.",
  },
  {
    file: "palette.jsx",
    domain: "desktop-shell",
    status: "implemented",
    desktopSurface: "CommandPalette",
    evidence: "CommandPalette indexes NAV_ROUTES, OP_CATALOG, and Ask queries.",
    decision: "Implemented for routes and operations; search depth follows the catalog.",
  },
  {
    file: "primitives.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "CSS/component primitives",
    evidence: "Global CSS and local React components implement Desktop-specific equivalents.",
    decision: "Primitives are adapted, not imported directly from the design folder.",
  },
  {
    file: "recovery.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/recovery",
    routes: ["/recovery"],
    operationKinds: ["operator-restore", "export-backup"],
    evidence: "Recovery route, restore operation, and offline backup operation exist.",
    decision: "Peer-vouched recovery remains deferred until a runtime primitive exists.",
  },
  {
    file: "services.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/services",
    routes: ["/services"],
    evidence: "Services route exposes service role/status read models where available.",
    decision: "Role toggles, endpoint exposure, and firewall sync wait for machine-config diff/apply.",
  },
  {
    file: "setup-cluster.jsx",
    domain: "cluster-marketplace",
    status: "partial",
    desktopSurface: "/setup-cluster",
    routes: ["/setup-cluster"],
    operationKinds: ["cluster-form", "cluster-request-join", "cluster-vote-admit"],
    runtimePrereq: "CJ-1/formCluster runtime deployment for live submit success.",
    evidence: "Setup cluster route, CJ-1 request/vote submit prep, and 7 active + 3 standby formCluster submit prep are present.",
    decision: "Desktop builds and submits request/vote/form transactions with runtime preflight; incompatible runtimes fail before broadcast where preflight is available.",
  },
  {
    file: "setup-operator.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/setup-operator",
    routes: ["/setup-operator"],
    operationKinds: ["operator-register"],
    evidence: "Setup operator route, key settings, and ML-DSA register form path exist.",
    decision: "Desktop supports sign-up against current chain; OS owns first-boot key generation.",
  },
  {
    file: "site-chrome.jsx",
    domain: "public-site",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Public site chrome is not part of Desktop.",
    decision: "Track in the public web/designs repo.",
  },
  {
    file: "site-dag.jsx",
    domain: "public-site",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Public DAG explainer is not part of Desktop.",
    decision: "Track in the public web/designs repo.",
  },
  {
    file: "site-home.jsx",
    domain: "public-site",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Marketing home page is not part of Desktop.",
    decision: "Track in the public web/designs repo.",
  },
  {
    file: "site-pages.jsx",
    domain: "public-site",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Public site pages are not part of Desktop.",
    decision: "Track in the public web/designs repo.",
  },
  {
    file: "studio-ask.jsx",
    domain: "studio-tooling",
    status: "partial",
    desktopSurface: "AskRail/AskBar variants",
    evidence: "Desktop has Ask surfaces and tweak controls, but not the full studio canvas control set.",
    decision: "Studio-only authoring controls are deferred.",
  },
  {
    file: "studio-chrome.jsx",
    domain: "studio-tooling",
    status: "partial",
    desktopSurface: "TopBar/SideNav/TweaksPanel",
    evidence: "Desktop has production chrome plus tweak panel hooks.",
    decision: "Studio layout variants are not production routes.",
  },
  {
    file: "studio-navs.jsx",
    domain: "studio-tooling",
    status: "deferred",
    desktopSurface: "TweaksPanel",
    evidence: "TweaksPanel exists; alternate navigation layout switcher is not implemented.",
    decision: "Defer as design exploration; not W7 acceptance for the operator console.",
  },
  {
    file: "tweaks.jsx",
    domain: "studio-tooling",
    status: "partial",
    desktopSurface: "TweaksPanel",
    evidence: "TweaksPanel opens via postMessage and TopBar controls.",
    decision: "Only production-safe tweak controls are exposed.",
  },
  {
    file: "ux.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "OperationsDrawer and shared UX flows",
    evidence: "Operation drawer state machine and receipt flows are implemented.",
    decision: "Design-only drawer variants are mapped to the single audited operation drawer.",
  },
  {
    file: "wallet-trading-automation.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Desktop has no wallet trading or autonomous trading runtime.",
    decision: "Track in wallet product work, not operator onboarding.",
  },
  {
    file: "wallet-app.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "/wallets only",
    routes: ["/wallets"],
    evidence: "Desktop has a Treasury route; full consumer wallet app is not implemented here.",
    decision: "Defer the full wallet app; keep Desktop focused on operator treasury/bond operations.",
  },
  {
    file: "wallet-data.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "/wallets only",
    routes: ["/wallets"],
    evidence: "Wallet sample data is not consumed by Desktop.",
    decision: "Defer live wallet portfolio/trading data to wallet SDK/product work.",
  },
  {
    file: "wallet-mobile.jsx",
    domain: "mobile-wallet",
    status: "external",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Mobile wallet UI is not part of Tauri Desktop.",
    decision: "Track in mobile wallet product work.",
  },
  {
    file: "wallet-news.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "News feed is not part of the operator onboarding path.",
    decision: "Defer until wallet/news product scope is approved.",
  },
  {
    file: "wallet-pages.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "/wallets only",
    routes: ["/wallets"],
    evidence: "Desktop Treasury route is present; full wallet page stack is not implemented.",
    decision: "Track full wallet pages outside operator onboarding.",
  },
  {
    file: "wallet-shared.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "/wallets only",
    routes: ["/wallets"],
    evidence: "Desktop uses its own operator-console primitives.",
    decision: "Defer the shared wallet component system; Desktop uses operator-console primitives.",
  },
  {
    file: "wallet-token-detail.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Token-detail drilldown is not implemented in Desktop.",
    decision: "Track in wallet product work.",
  },
  {
    file: "wallet-token-modals.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Wallet transfer/buy/swap modals are not implemented in Desktop.",
    decision: "Track in wallet product work.",
  },
  {
    file: "wallet-trade.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "None in Monarch Desktop",
    evidence: "Trading UI is not part of current operator Desktop.",
    decision: "Track in wallet/trade product work.",
  },
  {
    file: "wallet-wallets.jsx",
    domain: "treasury-wallet",
    status: "deferred",
    desktopSurface: "/wallets only",
    routes: ["/wallets"],
    evidence: "Desktop Treasury route exists; multi-wallet manager is not implemented.",
    decision: "Track in wallet product work.",
  },
  {
    file: "wallets.jsx",
    domain: "treasury-wallet",
    status: "partial",
    desktopSurface: "/wallets",
    routes: ["/wallets"],
    operationKinds: ["redelegate", "operator-register"],
    evidence: "Treasury route exists and bond/delegation operations are cataloged.",
    decision: "Full consumer wallet, private receive, burn, swaps, and bridges remain deferred.",
  },
] satisfies ReadonlyArray<DesignSourceAuditEntry>;

export const LEGACY_HANDOFF_SOURCE_AUDIT = [
  {
    file: "app.jsx",
    domain: "desktop-shell",
    status: "superseded",
    desktopSurface: "App.tsx",
    evidence: "Legacy view switcher replaced by React Router shell.",
    decision: "Use current designs/src/app.jsx as the active baseline.",
  },
  {
    file: "ask.jsx",
    domain: "desktop-shell",
    status: "partial",
    desktopSurface: "AskBar/AskRail",
    evidence: "Ask surfaces exist; legacy mock response cards are not production behavior.",
    decision: "Use current Ask implementation.",
  },
  {
    file: "chrome.jsx",
    domain: "desktop-shell",
    status: "superseded",
    desktopSurface: "SideNav/TopBar",
    evidence: "Current shell and route registry supersede the handoff chrome.",
    decision: "Use current designs/src/chrome.jsx as baseline.",
  },
  {
    file: "cluster.jsx",
    domain: "cluster-marketplace",
    status: "partial",
    desktopSurface: "/cluster",
    routes: ["/cluster"],
    evidence: "Cluster route covers live cluster state and provider browsing.",
    decision: "Legacy invite/vouch flows are now CJ-1/deferred recovery items.",
  },
  {
    file: "data.jsx",
    domain: "shared-data",
    status: "superseded",
    desktopSurface: "SDK hooks and OP_CATALOG",
    evidence: "Legacy mock data replaced by current design data plus live SDK hooks.",
    decision: "Do not import legacy constants.",
  },
  {
    file: "hardware.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/hardware",
    routes: ["/hardware"],
    evidence: "Hardware route uses Talos bridge data.",
    decision: "Legacy hardware visuals are adapted to live readiness surfaces.",
  },
  {
    file: "home.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/home",
    routes: ["/home"],
    evidence: "Home route covers chain/cluster/operator summary.",
    decision: "Current route supersedes legacy home composition.",
  },
  {
    file: "install.jsx",
    domain: "setup",
    status: "partial",
    desktopSurface: "/install",
    routes: ["/install"],
    evidence: "Install/pairing route exists.",
    decision: "Legacy SSH install wizard is superseded by Talos/manual node pairing.",
  },
  {
    file: "logs.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/logs",
    routes: ["/logs"],
    evidence: "Logs route exists.",
    decision: "Current Talos log stream supersedes mock log list.",
  },
  {
    file: "metrics.jsx",
    domain: "node-service",
    status: "partial",
    desktopSurface: "/metrics",
    routes: ["/metrics"],
    evidence: "Metrics route exists.",
    decision: "Current telemetry helpers supersede mock metric cards.",
  },
  {
    file: "operations.jsx",
    domain: "operator-console",
    status: "partial",
    desktopSurface: "/operations and OperationsDrawer",
    routes: ["/operations"],
    operationKinds: ["operator-restore", "rotate-keys", "operator-restart", "redelegate", "export-backup"],
    evidence: "The five handoff operations map into OP_CATALOG entries or newer names.",
    decision: "Current operation catalog is the source of truth.",
  },
  {
    file: "palette.jsx",
    domain: "desktop-shell",
    status: "implemented",
    desktopSurface: "CommandPalette",
    evidence: "CommandPalette indexes routes, operations, and Ask queries.",
    decision: "Current palette supersedes legacy switcher.",
  },
  {
    file: "primitives.jsx",
    domain: "desktop-shell",
    status: "superseded",
    desktopSurface: "Global CSS/components",
    evidence: "Desktop owns production primitives.",
    decision: "Do not import legacy primitive globals.",
  },
  {
    file: "tweaks.jsx",
    domain: "studio-tooling",
    status: "partial",
    desktopSurface: "TweaksPanel",
    evidence: "Tweaks panel is wired through postMessage and TopBar.",
    decision: "Current production-safe tweaks supersede the handoff panel.",
  },
  {
    file: "validator.jsx",
    domain: "operator-console",
    status: "superseded",
    desktopSurface: "/operator",
    routes: ["/operator"],
    evidence: "Legacy validator screen is represented by the operator route using current terminology.",
    decision: "No new visible UX should use validator terminology.",
  },
] satisfies ReadonlyArray<DesignSourceAuditEntry>;
