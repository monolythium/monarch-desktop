import { describe, expect, it } from "vitest";
import { DESIGN_ROUTE_PATHS } from "./designParity";
import requiredE2eRoutes from "./e2eRequiredRoutes.json";
import { NAV_ROUTES, routeForChord } from "./routes";

describe("Monarch Desktop route registry", () => {
  it("covers every current Monarch design route", () => {
    const paths = new Set(NAV_ROUTES.map((route) => route.path));
    for (const path of DESIGN_ROUTE_PATHS) {
      expect(paths.has(path), path).toBe(true);
    }
  });

  it("keeps paths and keyboard chords unique", () => {
    const paths = NAV_ROUTES.map((route) => route.path);
    const chords = NAV_ROUTES.map((route) => route.chord);
    expect(new Set(paths).size).toBe(paths.length);
    expect(new Set(chords).size).toBe(chords.length);
  });

  it("resolves every registered chord", () => {
    for (const route of NAV_ROUTES) {
      expect(routeForChord(route.chord)).toBe(route.path);
    }
  });

  it("requires e2e evidence for every registered route", () => {
    expect(requiredE2eRoutes).toEqual(NAV_ROUTES.map((route) => route.path));
  });
});
