# codegraph-viz 3D overview — design

**Date:** 2026-08-05
**Status:** Approved design (brainstorming complete), pre-plan
**Builds on:** `docs/specs/2026-08-04-codegraph-viz-design.md`

## Goal

Add a rotatable 3D overview to `codegraph-viz`. The third dimension encodes
**directory depth** via soft springs: files start on depth strata and relax
toward each other along z when heavily connected. The existing 2D view remains
the default and is the degenerate case of the 3D camera looking straight down.

Scope is **overview only**: seeing whole-codebase shape, layer structure, and
cross-layer edges. Depth-emphasized selection context ("investigation mode") is
explicitly future work.

## Constraints inherited from v1

- Zero runtime npm dependencies; Node stdlib only in the CLI.
- Self-contained, offline, single-file HTML. No CDN, no bundler.
- Deterministic, precomputed layout; the browser only renders.
- Render-on-demand Canvas (no WebGL, no browser force simulation).
- Payload cap behavior (`--max-nodes`, `--force`) unchanged.

## Design

### 1. Layout: z as a separate deterministic pass

The proven 2D force layout is **not** rewritten. `computeLayout` runs exactly
as today for x/y, then a new depth pass assigns z.

**Depth.** `rawDepth(file)` = number of `/` separators in the file's path,
clamped to `MAX_LAYERS = 12` (this is `depthOf` in the implementation).
Root-level files have raw depth 0. Depths are then normalized by the
shallowest file: `depth(f) = rawDepth(f) − minDepth`, so the top layer always
sits at z = 0 and same-depth repositories come out flat.

**Spacing.** Computed *after* x/y layout so vertical scale is proportional to
lateral extent:

```
zTarget = Z_RANGE_FRACTION × max(xRange, yRange)   // Z_RANGE_FRACTION = 0.4
spacing = maxDepth > 0 ? zTarget / maxDepth : 0   // maxDepth over normalized depths
layerZ(f) = depth(f) × spacing
```

**Relaxation.** `Z_TICKS = 60` iterations, two forces only, Jacobi-style
(compute all deltas from the current state, then apply — iteration order is
fixed so results are deterministic without any RNG):

- Layer spring: `Δz(f) += (layerZ(f) − z(f)) × LAYER_SPRING` (`0.08`)
- Edge attraction: for each aggregate file edge `(s, t, w)`, normalized weight
  `wn = w / maxWeight`, pull `= (z(t) − z(s)) × EDGE_Z_STRENGTH × wn`
  (`EDGE_Z_STRENGTH = 0.02`); apply half to each endpoint.

Both forces contract toward values inside `[0, zTarget]`; a per-tick clamp
to `[0, zTarget]` guards files with many edges, whose summed Jacobi delta
weights could otherwise overshoot the range in a single tick. No RNG anywhere
in this pass: z initializes exactly at `layerZ(f)`, so determinism is
structural, not seeded.

**Symbols.** `z(symbol) = z(parentFile)`. Symbol discs stay horizontal in the
file's plane.

**Placement.** New module `packages/codegraph-viz/lib/depth-layout.mjs`
exporting `assignDepth(nodes, fileEdges)`. `computeLayout` calls it before
returning, so all existing callers get a 3D-ready model unchanged. Nodes gain a
`z` field (number, always finite).

**Degenerate cases.** All files at the same depth → normalization makes every
depth 0 → `spacing = 0`, all z = 0 (the 3D toggle then rotates a flat graph —
an honest no-op). Single-file indexes keep existing degenerate handling;
z = 0.

### 2. Projection: `lib/projection.mjs` (pure, unit-testable)

One orthographic camera. State: `{ yaw, pitch, k, tx, ty }`.

```
rotate(x, y, z, yaw, pitch):
  x' = x·cos(yaw) − y·sin(yaw)
  y' = x·sin(yaw) + y·cos(yaw)          // yaw about world z (turntable)
  y'' = y'·cos(pitch) − z·sin(pitch)   // pitch about rotated x (tilt)
  z'' = y'·sin(pitch) + z·cos(pitch)
  return [x', y'', z'']

project(node, cam) → [sx, sy, depth]:
  [x', y'', z''] = rotate(node.x, node.y, node.z, cam.yaw, cam.pitch)
  return [x'·cam.k + cam.tx, y''·cam.k + cam.ty, z'']
```

At `yaw = 0, pitch = 0` this **equals the current 2D affine transform exactly**
(`sx = x·k + tx, sy = y·k + ty`). That equivalence is a unit test, not a hope.

Depth cues without perspective: painter's-order drawing (far first) plus
alpha/brightness fade by normalized depth. Node radii stay constant in screen
space, preserving the current look.

Exports are plain function declarations plus a single trailing
`export { … }` line (see §5 for how this is inlined).

### 3. Viewer changes (`viewer/viewer.js`)

**Camera.** State gains `{ yaw, pitch }`; 2D mode is `yaw = 0, pitch = 0`.
Pitch clamps to `[0, 80°]`; yaw wraps freely. Rotation sensitivity ≈ 0.01
rad/px.

**HUD.** A `3D` toggle button next to the edge-kind checkboxes. Off → behavior
byte-identical to today (drag pans). On → drag orbits, Shift+drag or
right-drag pans, wheel zooms as today. The camera remembers the last 3D angles
for the session; toggling off returns to top-down; toggling on first time uses
`pitch = 45°, yaw = 0`. Double-click empty space resets the camera and refits.

**Rendering.** In 3D mode: project all visible nodes, cull in screen space
(projection of even 50k points is a few ms; cheaper than rotating a world-rect
culler), sort by depth, draw edges then nodes with depth fade. In 2D mode keep
the existing `visibleWorldRect` fast path untouched.

**Picking.** The existing point-quadtree pick index is rebuilt over
**projected** screen positions whenever the camera, expansion set, or toggles
change (dirty-flag + lazy rebuild, the pattern already used). Click, hover,
hit regions, and `nearestSymbol` are unchanged — they operate in screen space.

**Drag degrade.** While a rotation drag is active, labels and symbol discs are
skipped (files + edges only); full render resumes on pointerup. This is the
performance safety valve; render-on-demand framing already exists.

**Fit.** `fitToContent` computes the rotated AABB of file discs (project file
centers, expand by radius) on load, on 3D-toggle, and on camera reset. No
auto-refit during rotation.

**ESC** behavior is unchanged (two-stage clear/collapse); it does not touch
the camera.

### 4. Payload and CLI

Every node gains `z`. No meta changes, no version marker — viewer and payload
are co-versioned inside one HTML. z adds one float per node, negligible after
gzip. **No new CLI flags**: every generated HTML can rotate.

### 5. Inlining two JS sources without a bundler

`buildHtml` currently inlines one viewer source string. `projection.mjs` must
reach the browser too, with its `export` intact for Node tests. Solution:
`emit.mjs` gains `inlineViewerSources(projectionJs, viewerJs)` which strips the
single trailing `export { … };` line from the projection source (anchored
regex `^export \{[^}]*\};?\s*$`) and concatenates projection before viewer. An
emit test asserts the HTML contains the projection functions and no residual
`export {`. `viz.mjs` reads both files from the package directory and passes
them through.

### 6. Error handling

- `assignDepth` validates inputs produce finite z; a non-finite result throws
  (bug, not user data) — covered by property tests over fixtures.
- Deep repositories clamp at `MAX_LAYERS` rather than producing absurd towers.
- Rotation with an empty/single-node model renders the same as 2D (no special
  case needed beyond pitch clamping).

### 7. Testing

- **`test/depth-layout.test.mjs` (new):** determinism across runs; with no
  file edges, z equals `depth × spacing` exactly (only the spring force acts
  and z initializes at its target); with edges, all z stay finite and within
  `[0, zTarget]`; symbols inherit file z; all-same-depth → all z = 0; depth
  clamped at `MAX_LAYERS`.
- **`test/projection.test.mjs` (new):** top-down equivalence to the affine
  transform; known-point rotations for yaw and pitch; screen position
  independent of z at pitch = 0; depth monotonic in world z at pitch > 0.
- **`test/emit.test.mjs` (extended):** payload nodes include `z`; HTML
  contains projection source with exports stripped.
- **Playwright smoke (extended temp harness):** toggle 3D, drag to rotate —
  canvas hash changes; click a node at its computed projected position —
  selection works after rotation; toggle off — 2D behavior restored.

## Out of scope (YAGNI)

- Investigation-mode depth emphasis (highlighting caller/callee layers on
  selection) — the motivating future feature, deliberately deferred.
- Perspective projection, WebGL, three.js or any vendored 3D library.
- 3D placement of symbols within files (z-jitter).
- Full 3D Barnes–Hut (octree) force simulation — the z-pass makes it
  unnecessary.
- Depth-histogram adaptive spacing beyond `MAX_LAYERS` clamping.
- New CLI flags.

## Future work

Depth-emphasized selection context, perspective option, adaptive strata
spacing from the depth histogram.
