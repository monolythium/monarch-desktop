# Monarch Design Parity Audit

Status: source-audit gate implemented; browser screenshot proof remains a W7 release-evidence task.

The checked-in audit source is `src/nav/designParity.ts`.

It accounts for:

- every current Monarch design JSX file under `../designs/src/*.jsx`;
- every legacy Monarch JSX design source file when the archived sibling source folder is present;
- every implemented Desktop route in `NAV_ROUTES`;
- every design operation id from `../designs/src/data.jsx`;
- every operation kind referenced by the Desktop operation catalog.

Each design file is classified as one of:

- `implemented`: live Desktop behavior exists;
- `partial`: Desktop has the route/surface, but some backend/runtime/product support is still pending;
- `deferred`: intentionally not implemented in Desktop yet;
- `superseded`: older design source replaced by the current design/app implementation;
- `external`: belongs to another product surface such as Monoscan, the browser extension, the mobile wallet, or the public site.

`src/nav/designParity.test.ts` scans the sibling design folders when present. If a designer adds a JSX file, a route, or an operation, the Desktop test suite fails until the implementation is either wired or explicitly deferred with evidence and a decision.

Browser/Tauri proof is separate from this source audit. The release harness in `scripts/run-tauri-e2e.mjs` reads `src/nav/e2eRequiredRoutes.json`, clicks through every registered Desktop route, captures a PNG screenshot for each route, and produces `monarch-desktop-e2e-evidence/v1` when a built Tauri app, `tauri-driver`, and OS smoke evidence are available. The verifier rejects evidence that is missing route screenshots, references unsafe screenshot paths, has mismatched SHA-256 metadata, or records undersized PNG dimensions. The release lane still needs to run this harness against the current app/OS pair to produce fresh artifacts.
