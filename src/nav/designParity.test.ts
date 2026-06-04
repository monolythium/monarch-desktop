import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import { OP_CATALOG } from "../ops/catalog";
import type { OpKind } from "../ops/types";
import {
  CATALOG_PRODUCT_EXTENSION_KINDS,
  DESIGN_SOURCE_AUDIT,
  DESIGN_OPERATION_IDS,
  DESIGN_OPERATION_PARITY,
  DESIGN_ROUTE_IDS,
  DESIGN_ROUTE_PATHS,
  LEGACY_HANDOFF_SOURCE_AUDIT,
} from "./designParity";
import { NAV_ROUTES } from "./routes";

function readSiblingDesignFile(name: string): string | null {
  const path = join(process.cwd(), "..", "designs", "src", name);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function readSiblingDesignFiles(relativeDir: string): string[] | null {
  const path = join(process.cwd(), "..", "designs", relativeDir);
  if (!existsSync(path)) return null;
  const result = spawnSync("find", [path, "-maxdepth", "1", "-type", "f", "-name", "*.jsx"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || `failed to list design files in ${path}`);
  }
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((file) => file.slice(file.lastIndexOf("/") + 1))
    .sort();
}

function publicDesignAuditFileName(name: string): string {
  if (/^wallet-[a-z]+-trading\.jsx$/u.test(name)) {
    return "wallet-trading-automation.jsx";
  }
  return name;
}

function extractScreensObject(source: string): string {
  const marker = "const screens = {";
  const start = source.indexOf(marker);
  expect(start, "design app.jsx must define const screens").toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, i);
    }
  }

  throw new Error("design app.jsx screens object is unterminated");
}

function extractDesignRouteIds(source: string): string[] {
  const body = extractScreensObject(source);
  return [...body.matchAll(/["']?([a-z][a-z0-9-]*)["']?\s*:/g)].flatMap(
    (match) => (match[1] ? [match[1]] : []),
  );
}

function extractDesignOperationsArray(source: string): string {
  const marker = "const OPERATIONS = [";
  const start = source.indexOf(marker);
  expect(start, "design data.jsx must define const OPERATIONS").toBeGreaterThanOrEqual(0);

  const bodyStart = source.indexOf("[", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) return source.slice(bodyStart + 1, i);
    }
  }

  throw new Error("design data.jsx OPERATIONS array is unterminated");
}

function extractDesignOperationIds(source: string): string[] {
  const body = extractDesignOperationsArray(source);
  return [...body.matchAll(/\bid:\s*"([^"]+)"/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function parityCatalogKind(
  entry: (typeof DESIGN_OPERATION_PARITY)[keyof typeof DESIGN_OPERATION_PARITY],
): OpKind | null {
  if (entry.status === "implemented") return entry.kind;
  return "relatedKind" in entry ? entry.relatedKind ?? null : null;
}

describe("Monarch design parity", () => {
  it("keeps the route snapshot synced with the sibling design source when available", () => {
    const source = readSiblingDesignFile("app.jsx");
    if (!source) return;

    expect(extractDesignRouteIds(source)).toEqual([...DESIGN_ROUTE_IDS]);
  });

  it("covers every current Monarch design route in the implemented registry", () => {
    const implementedPaths = new Set(NAV_ROUTES.map((route) => route.path));

    for (const path of DESIGN_ROUTE_PATHS) {
      expect(implementedPaths.has(path), path).toBe(true);
    }
  });

  it("keeps the operation snapshot synced with the sibling design source when available", () => {
    const source = readSiblingDesignFile("data.jsx");
    if (!source) return;

    expect(extractDesignOperationIds(source)).toEqual([...DESIGN_OPERATION_IDS]);
  });

  it("accounts for every design operation as implemented or explicitly deferred", () => {
    const parityIds = Object.keys(DESIGN_OPERATION_PARITY).sort();

    expect(parityIds).toEqual([...DESIGN_OPERATION_IDS].sort());

    for (const id of DESIGN_OPERATION_IDS) {
      const entry = DESIGN_OPERATION_PARITY[id];
      if (entry.status === "implemented") {
        expect(entry.note.trim().length, id).toBeGreaterThan(0);
      } else {
        expect(entry.reason.trim().length, id).toBeGreaterThan(0);
      }
    }
  });

  it("points implemented or related design operations at real operation catalog kinds", () => {
    const catalogKinds = new Set<OpKind>(OP_CATALOG.map((entry) => entry.kind));

    for (const id of DESIGN_OPERATION_IDS) {
      const kind = parityCatalogKind(DESIGN_OPERATION_PARITY[id]);
      if (kind) expect(catalogKinds.has(kind), `${id} -> ${kind}`).toBe(true);
    }
  });

  it("traces every catalog operation to the design or an explicit product extension", () => {
    const parityKinds = new Set<OpKind>();
    for (const id of DESIGN_OPERATION_IDS) {
      const kind = parityCatalogKind(DESIGN_OPERATION_PARITY[id]);
      if (kind) parityKinds.add(kind);
    }
    for (const kind of CATALOG_PRODUCT_EXTENSION_KINDS) {
      parityKinds.add(kind);
    }

    for (const entry of OP_CATALOG) {
      expect(parityKinds.has(entry.kind), entry.kind).toBe(true);
    }
  });

  it("accounts for every current Monarch design JSX source file", () => {
    const files = readSiblingDesignFiles("src");
    if (!files) return;

    expect(DESIGN_SOURCE_AUDIT.map((entry) => entry.file).sort()).toEqual(
      files.map(publicDesignAuditFileName).sort(),
    );
  });

  it("accounts for every legacy Monarch handoff JSX source file", () => {
    const files = readSiblingDesignFiles("design_handoff_monarch/src");
    if (!files) return;

    expect(LEGACY_HANDOFF_SOURCE_AUDIT.map((entry) => entry.file).sort()).toEqual(files);
  });

  it("keeps design audit entries actionable and uniquely keyed", () => {
    const entries = [...DESIGN_SOURCE_AUDIT, ...LEGACY_HANDOFF_SOURCE_AUDIT];
    const currentKeys = new Set<string>();
    const legacyKeys = new Set<string>();

    for (const entry of DESIGN_SOURCE_AUDIT) {
      expect(currentKeys.has(entry.file), entry.file).toBe(false);
      currentKeys.add(entry.file);
    }
    for (const entry of LEGACY_HANDOFF_SOURCE_AUDIT) {
      expect(legacyKeys.has(entry.file), entry.file).toBe(false);
      legacyKeys.add(entry.file);
    }

    for (const entry of entries) {
      expect(entry.file.endsWith(".jsx"), entry.file).toBe(true);
      expect(entry.desktopSurface.trim().length, entry.file).toBeGreaterThan(0);
      expect(entry.evidence.trim().length, entry.file).toBeGreaterThan(0);
      expect(entry.decision.trim().length, entry.file).toBeGreaterThan(0);
      if (entry.status === "deferred" || entry.status === "external") {
        expect(entry.decision.toLowerCase(), entry.file).toMatch(
          /track|defer|outside|out of|wait|future/,
        );
      }
    }
  });

  it("binds audited route references to the implemented route registry", () => {
    const routePaths = new Set(NAV_ROUTES.map((route) => route.path));
    const auditedRoutes = new Set<string>();

    for (const entry of [...DESIGN_SOURCE_AUDIT, ...LEGACY_HANDOFF_SOURCE_AUDIT]) {
      for (const route of entry.routes ?? []) {
        expect(routePaths.has(route), `${entry.file} -> ${route}`).toBe(true);
        auditedRoutes.add(route);
      }
    }

    for (const route of NAV_ROUTES) {
      expect(auditedRoutes.has(route.path), route.path).toBe(true);
    }
  });

  it("binds audited operation references to the operation catalog", () => {
    const catalogKinds = new Set<OpKind>(OP_CATALOG.map((entry) => entry.kind));

    for (const entry of [...DESIGN_SOURCE_AUDIT, ...LEGACY_HANDOFF_SOURCE_AUDIT]) {
      for (const kind of entry.operationKinds ?? []) {
        expect(catalogKinds.has(kind), `${entry.file} -> ${kind}`).toBe(true);
      }
    }
  });
});
