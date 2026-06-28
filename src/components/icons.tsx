// Central icon registry. Monarch's sidebar, the ⌘K palette, the Operations
// page, and the Operations drawer all used to render a two-letter text slug
// (e.g. "HM", "RG") as a placeholder for a real icon. This module maps every
// nav route (by path) and every operation (by kind) to a fitting
// `lucide-react` icon by MEANING, with a clean fallback so an unmapped entry
// never crashes — it just renders the generic fallback glyph.
//
// Why lucide: MIT-licensed, tree-shakeable per-icon imports, ~1.6 stroke
// weight that matches the design handoff's hand-rolled stroke icons (the
// handoff explicitly permits "Lucide, Phosphor" — see
// designs/design_handoff_monarch/README.md). We pin the exact version like the
// rest of this repo's deps.

import {
  Activity,
  Antenna,
  Archive,
  ArrowRightLeft,
  Bell,
  Boxes,
  CircleHelp,
  Coins,
  Cpu,
  DoorOpen,
  Download,
  FileCheck2,
  FileSignature,
  Home,
  KeyRound,
  Landmark,
  Layers,
  LifeBuoy,
  ListChecks,
  MessagesSquare,
  Network,
  Pencil,
  Play,
  PlugZap,
  RefreshCw,
  RotateCw,
  ScrollText,
  Server,
  Settings,
  ShieldAlert,
  ShieldCheck,
  Snowflake,
  Square,
  Store,
  Tag,
  Undo2,
  Upload,
  User,
  UserPlus,
  Users,
  Vote,
  Wallet,
  Wand2,
  type LucideIcon,
} from "lucide-react";
import type { OpKind } from "../ops/types";

/** Generic fallback for any route/op kind we forgot to map. */
export const FALLBACK_ICON: LucideIcon = CircleHelp;

// Route path → icon. Mapped by meaning so the sidebar + palette read at a
// glance. Keep in sync with NAV_ROUTES when a new surface is added.
const ROUTE_ICONS: Record<string, LucideIcon> = {
  "/home": Home,
  "/operator": User,
  "/hardware": Cpu,
  "/operations": ListChecks,
  "/wallets": Wallet,
  "/audit": FileCheck2,
  "/cluster": Network,
  "/ceremony": Users,
  "/chat": MessagesSquare,
  "/marketplace": Store,
  "/services": Server,
  "/metrics": Activity,
  "/logs": ScrollText,
  "/governance": Landmark,
  "/alerts": Bell,
  "/setup": Wand2,
  "/welcome": ListChecks,
  "/install": Download,
  "/settings": Settings,
  "/setup-operator": UserPlus,
  "/setup-cluster": Boxes,
  "/attestation": ShieldCheck,
  "/keys": KeyRound,
  "/recovery": LifeBuoy,
};

// Operation kind → icon. Mapped by what the operator is actually doing.
const OP_ICONS: Record<OpKind, LucideIcon> = {
  // Node operations (system)
  "operator-restart": RotateCw,
  "set-log-retention": ScrollText,
  "clean-protocore-logs": ScrollText,
  "operator-stop": Square,
  "operator-start": Play,
  "ota-apply": Upload,
  "ota-rollback": Undo2,
  // Operator (cluster)
  "operator-register": UserPlus,
  "operator-restore": RefreshCw,
  "operator-display": Pencil,
  "chat-bootstrap-peers": Antenna,
  "cluster-name-register": Tag,
  "cluster-form": Boxes,
  "cluster-update-charter": FileSignature,
  "cluster-request-join": PlugZap,
  "cluster-vote-admit": Vote,
  "seat-apply": Store,
  "seat-vote-admit": Vote,
  "cluster-resign": DoorOpen,
  "cluster-accept-invite": UserPlus,
  "cluster-swap": ArrowRightLeft,
  // Keys
  "export-backup": Archive,
  // Funds (treasury)
  redelegate: Coins,
  // Recovery (emergency)
  "operator-reprovision": LifeBuoy,
  "operator-recover-keys": LifeBuoy,
  "operator-bootstrap": Layers,
  "freeze-admission": Snowflake,
  "emergency-key-rotation": ShieldAlert,
};

/** Resolve the icon component for a nav route path. */
export function routeIcon(path: string): LucideIcon {
  return ROUTE_ICONS[path] ?? FALLBACK_ICON;
}

/** Resolve the icon component for an operation kind. */
export function opIcon(kind: OpKind): LucideIcon {
  return OP_ICONS[kind] ?? FALLBACK_ICON;
}

/** Render a route icon at a given size (default 16, matching the sidebar). */
export function RouteIcon({
  path,
  size = 16,
  className,
}: {
  path: string;
  size?: number;
  className?: string;
}) {
  const Icon = routeIcon(path);
  return <Icon size={size} strokeWidth={1.6} className={className} aria-hidden />;
}

/** Render an operation icon at a given size (default 18). */
export function OpIcon({
  kind,
  size = 18,
  className,
}: {
  kind: OpKind;
  size?: number;
  className?: string;
}) {
  const Icon = opIcon(kind);
  return <Icon size={size} strokeWidth={1.6} className={className} aria-hidden />;
}
