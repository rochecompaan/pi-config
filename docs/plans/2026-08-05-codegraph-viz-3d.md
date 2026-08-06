# codegraph-viz 3D Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a rotatable 3D overview to codegraph-viz where z encodes directory depth via soft springs, with the existing 2D view as the camera's top-down special case.

**Architecture:** A deterministic z-assignment pass runs after the untouched 2D force layout (`lib/depth-layout.mjs`). A pure orthographic camera module (`lib/projection.mjs`) is unit-tested in Node and inlined into the generated HTML ahead of the viewer. The viewer gains `{yaw, pitch}` camera state, painter-ordered depth-faded rendering, screen-space picking, and a HUD `3D` toggle.

**Tech Stack:** Node 24 stdlib only (`node:test`, `node:sqlite`), hand-rolled Canvas 2D, zero runtime npm dependencies.

**Spec:** `docs/specs/2026-08-05-codegraph-viz-3d-design.md` (approved)

**Worktree:** `/home/roche/projects/pi/roche-pi/.worktrees/codegraph-viz-3d` on branch `add-codegraph-viz-3d` (already created; do not create another).

## Global Constraints

- Zero runtime npm dependencies; Node 24 stdlib only. No new CLI flags.
- `lib/projection.mjs` MUST use plain `function` declarations plus exactly one trailing `export { rotate, project };` line. `viewer/viewer.js` MUST contain no `import`/`export` (it is inlined into a classic `<script>`).
- The depth pass uses NO RNG: z initializes exactly at layer z; iteration order is fixed (Jacobi deltas). Layout determinism tests must keep passing.
- Constants (defined once in `lib/depth-layout.mjs`): `Z_RANGE_FRACTION = 0.4`, `MAX_LAYERS = 12`, `Z_TICKS = 60`, `LAYER_SPRING = 0.08`, `EDGE_Z_STRENGTH = 0.02`.
- Viewer constants: pitch clamp `PITCH_MAX = 80°`, rotation sensitivity `0.01 rad/px`, default 3D camera `{ yaw: 0, pitch: Math.PI / 4 }`.
- Package tests run with `npm test` from `packages/codegraph-viz` (NOT `node --test test/`). Baseline: 23 tests passing at `4daab42`.
- Commits: Conventional Commits, no sign-offs.

---

### Task 1: Directory-depth z layout

**Files:**
- Create: `packages/codegraph-viz/lib/depth-layout.mjs`
- Create: `packages/codegraph-viz/test/depth-layout.test.mjs`
- Modify: `packages/codegraph-viz/lib/layout.mjs` (import + one call before `return model;`)

**Interfaces:**
- Produces: `assignDepth(nodes, fileEdges) → nodes` — mutates each node, adding a finite `z` number (files from depth layers, symbols inherit `z` of `parent` file). Called with nodes that already have x/y from the 2D layout.
- Produces: `depthOf(file) → int` — `/`-separator count in `file.file`, clamped to `MAX_LAYERS`.
- Produces: after `computeLayout(model)`, every node in the model carries `z`. `model.fileEdges` items are `{ source, target, kind, weight }` (file-level ids).
- Consumed by: Task 4 (viewer reads `node.z`), Task 5 (payload assertions).

- [ ] **Step 1: Write the failing tests**

Create `packages/codegraph-viz/test/depth-layout.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureProject } from "./fixture.mjs";
import { extractGraph } from "../lib/extract.mjs";
import { computeLayout } from "../lib/layout.mjs";
import { assignDepth, depthOf, Z_RANGE_FRACTION, MAX_LAYERS } from "../lib/depth-layout.mjs";

function handModel() {
  // x/y preset; depths 0, 1, 2 after min-depth normalization.
  return {
    nodes: [
      { id: "file:root.ts", kind: "file", file: "root.ts", parent: null, x: 0, y: 0 },
      { id: "file:src/a.ts", kind: "file", file: "src/a.ts", parent: null, x: 100, y: 0 },
      { id: "file:src/lib/b.ts", kind: "file", file: "src/lib/b.ts", parent: null, x: 0, y: 200 },
      { id: "fn:a", kind: "function", file: "src/a.ts", parent: "file:src/a.ts", x: 100, y: 5 },
    ],
    fileEdges: [],
  };
}

test("with no file edges, z equals normalized depth x spacing; symbols inherit file z", () => {
  const model = handModel();
  assignDepth(model.nodes, model.fileEdges);
  // xRange=100, yRange=200 -> zTarget = 0.4*200 = 80; maxDepth=2 -> spacing=40.
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  assert.equal(byId.get("file:root.ts").z, 0);
  assert.equal(byId.get("file:src/a.ts").z, 40);
  assert.equal(byId.get("file:src/lib/b.ts").z, 80);
  assert.equal(byId.get("fn:a").z, 40);
});

test("assignDepth is deterministic", () => {
  const run = () => {
    const model = handModel();
    model.fileEdges = [{ source: "file:root.ts", target: "file:src/lib/b.ts", kind: "calls", weight: 2 }];
    assignDepth(model.nodes, model.fileEdges);
    return model.nodes.map((n) => n.z);
  };
  assert.deepEqual(run(), run());
});

test("edge attraction pulls connected files off their layer; z stays in range", () => {
  const model = handModel();
  model.fileEdges = [{ source: "file:root.ts", target: "file:src/lib/b.ts", kind: "calls", weight: 2 }];
  assignDepth(model.nodes, model.fileEdges);
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const deep = byId.get("file:src/lib/b.ts");
  assert.ok(deep.z < 80, `deep file pulled toward caller (z=${deep.z})`);
  for (const n of model.nodes) {
    assert.ok(Number.isFinite(n.z), `${n.id} z finite`);
    assert.ok(n.z >= 0 && n.z <= 80, `${n.id} z in [0, zTarget] (z=${n.z})`);
  }
});

test("all files at the same depth normalize to z = 0", () => {
  const nodes = [
    { id: "file:src/a.ts", kind: "file", file: "src/a.ts", parent: null, x: 0, y: 0 },
    { id: "file:src/b.ts", kind: "file", file: "src/b.ts", parent: null, x: 50, y: 0 },
  ];
  assignDepth(nodes, []);
  assert.deepEqual(nodes.map((n) => n.z), [0, 0]);
});

test("depthOf counts separators and clamps at MAX_LAYERS", () => {
  assert.equal(depthOf({ file: "root.ts" }), 0);
  assert.equal(depthOf({ file: "src/lib/deep.ts" }), 2);
  assert.equal(depthOf({ file: "a/b/c/d/e/f/g/h/i/j/k/l/m/n.ts" }), MAX_LAYERS);
});

test("computeLayout output carries finite z on every node", () => {
  const model = computeLayout(extractGraph(createFixtureProject().dir));
  assert.ok(model.nodes.length > 0);
  for (const n of model.nodes) {
    assert.ok(Number.isFinite(n.z), `${n.id} z finite`);
    assert.ok(n.z >= 0, `${n.id} z non-negative`);
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/depth-layout.test.mjs`
Expected: FAIL with `Cannot find module '../lib/depth-layout.mjs'`

- [ ] **Step 3: Implement `lib/depth-layout.mjs`**

```javascript
// Directory-depth z assignment ("soft strata").
// Runs after the 2D force layout: files start on normalized depth layers,
// then relax along z through aggregate edge attraction. No RNG: z
// initializes exactly at the layer, and per-tick deltas are computed
// Jacobi-style in fixed order, so results are deterministic.

export const Z_RANGE_FRACTION = 0.4;
export const MAX_LAYERS = 12;
export const Z_TICKS = 60;
export const LAYER_SPRING = 0.08;
export const EDGE_Z_STRENGTH = 0.02;

export function depthOf(file) {
  const path = file.file ?? "";
  return Math.min((path.match(/\//g) ?? []).length, MAX_LAYERS);
}

export function assignDepth(nodes, fileEdges) {
  const files = nodes.filter((n) => n.kind === "file");
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of files) {
    minX = Math.min(minX, f.x);
    maxX = Math.max(maxX, f.x);
    minY = Math.min(minY, f.y);
    maxY = Math.max(maxY, f.y);
  }
  const zTarget = Z_RANGE_FRACTION * Math.max(Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));

  // Normalize by the shallowest depth so same-depth repos land flat at z = 0.
  const depths = new Map(files.map((f) => [f.id, depthOf(f)]));
  let minDepth = Infinity;
  for (const d of depths.values()) minDepth = Math.min(minDepth, d);
  if (!Number.isFinite(minDepth)) minDepth = 0;
  let maxDepth = 0;
  for (const [id, d] of depths) {
    const effective = d - minDepth;
    depths.set(id, effective);
    maxDepth = Math.max(maxDepth, effective);
  }
  const spacing = maxDepth > 0 ? zTarget / maxDepth : 0;

  const layerZ = new Map(files.map((f) => [f.id, depths.get(f.id) * spacing]));
  const z = new Map(files.map((f) => [f.id, layerZ.get(f.id)]));

  let maxWeight = 0;
  for (const e of fileEdges) maxWeight = Math.max(maxWeight, e.weight);

  for (let tick = 0; tick < Z_TICKS && maxDepth > 0; tick++) {
    const deltas = new Map(files.map((f) => [f.id, 0]));
    for (const f of files) {
      deltas.set(f.id, (layerZ.get(f.id) - z.get(f.id)) * LAYER_SPRING);
    }
    for (const e of fileEdges) {
      if (!z.has(e.source) || !z.has(e.target)) continue;
      const pull = (z.get(e.target) - z.get(e.source)) * EDGE_Z_STRENGTH * (e.weight / maxWeight);
      deltas.set(e.source, deltas.get(e.source) + pull / 2);
      deltas.set(e.target, deltas.get(e.target) - pull / 2);
    }
    // Clamp so many-edge files cannot overshoot the strata range.
    for (const f of files) {
      z.set(f.id, Math.min(Math.max(z.get(f.id) + deltas.get(f.id), 0), zTarget));
    }
  }

  for (const node of nodes) {
    node.z = node.kind === "file" ? (z.get(node.id) ?? 0) : (z.get(node.parent) ?? 0);
    if (!Number.isFinite(node.z)) {
      throw new Error(`assignDepth produced non-finite z for ${node.id}`);
    }
  }
  return nodes;
}
```

- [ ] **Step 4: Run the new tests**

Run: `cd packages/codegraph-viz && node --test test/depth-layout.test.mjs`
Expected: 5/6 pass; only `computeLayout output carries finite z on every node` FAILS (wiring comes next)

- [ ] **Step 5: Wire into `computeLayout`**

In `packages/codegraph-viz/lib/layout.mjs`, add after the existing header comment block (before `export function computeLayout`):

```javascript
import { assignDepth } from "./depth-layout.mjs";
```

Replace the final `return model;` with:

```javascript
  assignDepth(model.nodes, model.fileEdges);
  return model;
```

- [ ] **Step 6: Run the full package suite**

Run: `cd packages/codegraph-viz && npm test`
Expected: `ℹ tests 29`, `ℹ pass 29`, `ℹ fail 0`

- [ ] **Step 7: Commit**

```bash
git add packages/codegraph-viz/lib/depth-layout.mjs packages/codegraph-viz/test/depth-layout.test.mjs packages/codegraph-viz/lib/layout.mjs
git commit -m "feat(codegraph-viz): add directory-depth z layout"
```

---

### Task 2: Orthographic projection module

**Files:**
- Create: `packages/codegraph-viz/lib/projection.mjs`
- Create: `packages/codegraph-viz/test/projection.test.mjs`

**Interfaces:**
- Produces: `rotate(x, y, z, yaw, pitch) → [x1, y2, z2]` — yaw about world z, then pitch about the rotated x axis.
- Produces: `project(node, cam) → [sx, sy, depth]` — `node` is anything with `x`, `y`, optional `z`; `cam` is `{ yaw, pitch, k, tx, ty }`.
- Consumed by: Task 3 (inlined into HTML), Task 4 (viewer calls the globals), Task 5 (smoke harness imports the module to replicate camera math).
- Hard constraint: plain `function` declarations + one trailing `export { rotate, project };` line, nothing else exported.

- [ ] **Step 1: Write the failing tests**

Create `packages/codegraph-viz/test/projection.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { rotate, project } from "../lib/projection.mjs";

test("top-down projection equals the 2D affine transform", () => {
  const cam = { yaw: 0, pitch: 0, k: 2, tx: 10, ty: 20 };
  assert.deepEqual(project({ x: 3, y: -2, z: 5 }, cam), [16, 16, 5]);
  assert.deepEqual(project({ x: 3, y: -2, z: -7 }, cam), [16, 16, -7]);
  assert.deepEqual(project({ x: 3, y: -2 }, cam), [16, 16, 0]);
});

test("yaw rotates points around the vertical axis", () => {
  const [x, y, z] = rotate(1, 0, 0, Math.PI / 2, 0);
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(y - 1) < 1e-12 && z === 0);
});

test("pitch tilts world z onto the screen y axis", () => {
  const [x, y, z] = rotate(0, 0, 1, 0, Math.PI / 2);
  assert.ok(x === 0 && Math.abs(y + 1) < 1e-12 && Math.abs(z) < 1e-12);
});

test("depth increases with world z when tilted", () => {
  const cam = { yaw: 0, pitch: Math.PI / 4, k: 1, tx: 0, ty: 0 };
  const near = project({ x: 0, y: 0, z: 0 }, cam);
  const far = project({ x: 0, y: 0, z: 10 }, cam);
  assert.ok(far[2] > near[2]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/projection.test.mjs`
Expected: FAIL with `Cannot find module '../lib/projection.mjs'`

- [ ] **Step 3: Implement `lib/projection.mjs`**

```javascript
// Pure orthographic camera math for the rotatable 3D overview.
// Plain function declarations plus one trailing export line: emit.mjs
// strips the export when inlining this source ahead of the viewer into
// the generated HTML (a classic script, where `export` would be invalid).

function rotate(x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = x * cy - y * sy;
  const y1 = x * sy + y * cy;
  const y2 = y1 * cp - z * sp;
  const z2 = y1 * sp + z * cp;
  return [x1, y2, z2];
}

function project(node, cam) {
  const [px, py, depth] = rotate(node.x, node.y, node.z ?? 0, cam.yaw, cam.pitch);
  return [px * cam.k + cam.tx, py * cam.k + cam.ty, depth];
}

export { rotate, project };
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/codegraph-viz && node --test test/projection.test.mjs`
Expected: PASS, 4/4

- [ ] **Step 5: Run the full package suite**

Run: `cd packages/codegraph-viz && npm test`
Expected: `ℹ tests 33`, `ℹ pass 33`, `ℹ fail 0`

- [ ] **Step 6: Commit**

```bash
git add packages/codegraph-viz/lib/projection.mjs packages/codegraph-viz/test/projection.test.mjs
git commit -m "feat(codegraph-viz): add orthographic projection module"
```

---

### Task 3: Inline the projection source into emitted HTML

**Files:**
- Modify: `packages/codegraph-viz/lib/emit.mjs` (add `inlineViewerSources`)
- Modify: `packages/codegraph-viz/viz.mjs` (read projection source, pass combined source)
- Modify: `packages/codegraph-viz/test/emit.test.mjs` (two new tests)
- Modify: `packages/codegraph-viz/test/cli.test.mjs` (extend the generated-html test)

**Interfaces:**
- Consumes: Task 2's `lib/projection.mjs` file on disk (read as text; its trailing `export { … }` line is stripped).
- Produces: `inlineViewerSources(projectionJs, viewerJs) → string` — export-stripped projection source, a newline, then the viewer source. Throws if the export line is missing.
- `buildHtml(model, viewerJs)` signature is UNCHANGED; it now receives the combined source.
- After this task, generated HTML contains `function project(` and no `export {`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/codegraph-viz/test/emit.test.mjs` (update the import line too):

```javascript
// change the existing import to:
// import { buildHtml, extractPayload, inlineViewerSources } from "../lib/emit.mjs";

test("inlineViewerSources strips the export line and keeps source order", () => {
  const projection = "function rotate() {}\nfunction project() {}\nexport { rotate, project };\n";
  const out = inlineViewerSources(projection, "/* viewer */");
  assert.ok(!out.includes("export {"));
  assert.ok(out.indexOf("function project()") < out.indexOf("/* viewer */"));
});

test("inlineViewerSources rejects a projection source without an export line", () => {
  assert.throws(() => inlineViewerSources("function project() {}\n", ""), /export/);
});
```

And in `packages/codegraph-viz/test/cli.test.mjs`, extend the `"generates a working html file from an index"` test — replace its final assertion line with:

```javascript
  assert.ok(model.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z)));
  const html = readFileSync(out, "utf8");
  assert.ok(html.includes("function project("));
  assert.ok(!html.includes("export {"));
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/emit.test.mjs test/cli.test.mjs`
Expected: FAIL — `inlineViewerSources is not a function` (emit) and `function project(` not found (cli)

- [ ] **Step 3: Implement `inlineViewerSources` in `lib/emit.mjs`**

Add near the top of `packages/codegraph-viz/lib/emit.mjs`, after the `PAYLOAD_RE` line:

```javascript
const EXPORT_LINE_RE = /^export \{[^}]*\};?\s*$/m;

// Concatenates projection + viewer into one classic-script source for
// inlining. projection.mjs keeps a single trailing `export { … }` line so
// Node tests can import it; that line is a syntax error in a classic
// browser script and must be stripped here. Throws on refactor drift.
export function inlineViewerSources(projectionJs, viewerJs) {
  if (!EXPORT_LINE_RE.test(projectionJs)) {
    throw new Error("projection.mjs must contain a single `export { … }` line");
  }
  return `${projectionJs.replace(EXPORT_LINE_RE, "")}\n${viewerJs}`;
}
```

- [ ] **Step 4: Wire `viz.mjs`**

In `packages/codegraph-viz/viz.mjs`, replace:

```javascript
import { buildHtml } from "./lib/emit.mjs";
```

with:

```javascript
import { buildHtml, inlineViewerSources } from "./lib/emit.mjs";
```

and replace:

```javascript
  const viewerJs = readFileSync(
    join(import.meta.dirname, "viewer", "viewer.js"),
    "utf8",
  );
  const html = buildHtml(model, viewerJs);
```

with:

```javascript
  const projectionJs = readFileSync(
    join(import.meta.dirname, "lib", "projection.mjs"),
    "utf8",
  );
  const viewerJs = readFileSync(
    join(import.meta.dirname, "viewer", "viewer.js"),
    "utf8",
  );
  const html = buildHtml(model, inlineViewerSources(projectionJs, viewerJs));
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/codegraph-viz && node --test test/emit.test.mjs test/cli.test.mjs`
Expected: PASS (emit 6/6, cli 4/4)

- [ ] **Step 6: Run the full package suite**

Run: `cd packages/codegraph-viz && npm test`
Expected: `ℹ tests 35`, `ℹ pass 35`, `ℹ fail 0`

- [ ] **Step 7: Commit**

```bash
git add packages/codegraph-viz/lib/emit.mjs packages/codegraph-viz/viz.mjs packages/codegraph-viz/test/emit.test.mjs packages/codegraph-viz/test/cli.test.mjs
git commit -m "feat(codegraph-viz): inline projection source into emitted html"
```

---

### Task 4: Viewer 3D camera, rendering, picking, interaction

**Files:**
- Modify: `packages/codegraph-viz/viewer/viewer.js` (all changes below)
- Modify: `packages/codegraph-viz/lib/emit.mjs` (CSS for the HUD button only)
- Modify: `packages/codegraph-viz/README.md` (document 3D usage)

**Interfaces:**
- Consumes: globals `rotate(x, y, z, yaw, pitch)` and `project(node, cam)` from the inlined projection source (Task 3); `node.z` on payload nodes (Task 1).
- Produces (browser contract the Task 5 smoke relies on): a `<button id="mode3d">` appended to `#hud` with `aria-pressed`; toggle-on applies camera `{yaw: 0, pitch: Math.PI/4}` then refits; left-drag rotates at `0.01 rad/px` with pitch clamped to 80°; dblclick **on empty space** resets camera to top-down and refits; picking works at any camera.
- The viewer must stay a classic script: no `import`/`export`.
- At `yaw = 0, pitch = 0` the rendered output must match the pre-3D viewer exactly (depth fades are 1 and the ellipse degenerates to a circle).

- [ ] **Step 1: Extend the camera state**

In `packages/codegraph-viz/viewer/viewer.js`, replace:

```javascript
    matches: [], matchIndex: 0,
    k: 1, tx: 0, ty: 0,
    dirty: true,
  };
```

with:

```javascript
    matches: [], matchIndex: 0,
    k: 1, tx: 0, ty: 0,
    yaw: 0, pitch: 0,
    mode3d: false,
    camera3d: { yaw: 0, pitch: Math.PI / 4 },
    degrading: false,
    pickDirty: true,
    dirty: true,
  };
```

- [ ] **Step 2: Replace the transform helpers**

Replace:

```javascript
  // ---- transform helpers ----
  const toWorld = (sx, sy) => [(sx - state.tx) / state.k, (sy - state.ty) / state.k];
  const toScreen = (x, y) => [x * state.k + state.tx, y * state.k + state.ty];
  const owningFile = (node) => node.kind === "file" ? node.id : node.parent;
```

with:

```javascript
  // ---- transform helpers ----
  // rotate() and project() are globals from the projection source inlined
  // above this script. Camera fields live directly on `state`.
  // toWorld is only exact in top-down view (yaw=0, pitch=0); 3D zoom
  // anchors on the viewport center instead.
  const toWorld = (sx, sy) => [(sx - state.tx) / state.k, (sy - state.ty) / state.k];
  const topDown = () => state.yaw === 0 && state.pitch === 0;
  const owningFile = (node) => node.kind === "file" ? node.id : node.parent;
```

- [ ] **Step 3: Rotated-bounds `fitToContent`**

Replace the body of `fitToContent` (keep the function name and the trailing `fitToContent();` call):

```javascript
  function fitToContent() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of files) {
      const [px, py] = rotate(f.x, f.y, f.z ?? 0, state.yaw, state.pitch);
      minX = Math.min(minX, px - f.r);
      maxX = Math.max(maxX, px + f.r);
      minY = Math.min(minY, py - f.r);
      maxY = Math.max(maxY, py + f.r);
    }
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    state.k = Math.min(vw / w, vh / h) * 0.9;
    state.tx = vw / 2 - ((minX + maxX) / 2) * state.k;
    state.ty = vh / 2 - ((minY + maxY) / 2) * state.k;
  }
```

- [ ] **Step 4: Screen-space pick index**

Replace `rebuildPickIndex` with:

```javascript
  function rebuildPickIndex() {
    const pts = [];
    for (const s of symbols) {
      if (!state.expanded.has(s.parent)) continue;
      const [x, y] = project(s, state);
      pts.push({ x, y, sym: s });
    }
    symbolTree = buildPointTree(pts);
    state.pickDirty = false;
    state.dirty = true;
  }
```

Replace `nearestSymbol` with:

```javascript
  function nearestSymbol(sx, sy, maxDistPx) {
    if (state.pickDirty) rebuildPickIndex();
    let best = null, bestD = maxDistPx;
    (function visit(node) {
      if (!node) return;
      if (sx < node.x - bestD || sx > node.x + node.size + bestD) return;
      if (sy < node.y - bestD || sy > node.y + node.size + bestD) return;
      if (!node.children) {
        for (const point of node.points) {
          const d = Math.hypot(point.x - sx, point.y - sy);
          if (d < bestD) {
            best = point.sym;
            bestD = d;
          }
        }
      }
      if (node.children) for (const child of node.children) visit(child);
    })(symbolTree);
    return best;
  }
```

- [ ] **Step 5: Rewrite `render()` with projection cache, painter order, depth fade**

Replace the entire `render` function with:

```javascript
  function render() {
    if (!state.dirty) return;
    state.dirty = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1a1b26";
    ctx.fillRect(0, 0, vw, vh);
    const cull2d = topDown();
    const rect = cull2d ? visibleWorldRect() : null;
    const dimOthers = state.selected !== null;

    // Projection cache for this render pass.
    const proj = new Map();
    const P = (n) => {
      let p = proj.get(n.id);
      if (!p) {
        p = project(n, state);
        proj.set(n.id, p);
      }
      return p;
    };
    const visible = (n, worldPad) => {
      if (cull2d) return inRect(rect, n.x, n.y, worldPad);
      const [px, py] = P(n);
      const pad = worldPad * state.k + 20;
      return px >= -pad && px <= vw + pad && py >= -pad && py <= vh + pad;
    };

    // Painter-ordered node list (far first) and depth range for fading.
    const drawList = [];
    for (const f of files) {
      if (visible(f, f.r * 1.2)) drawList.push({ depth: P(f)[2], isFile: true, node: f });
    }
    if (!state.degrading) {
      for (const s of symbols) {
        if (!state.expanded.has(s.parent)) continue;
        if (visible(s, 20)) drawList.push({ depth: P(s)[2], isFile: false, node: s });
      }
    }
    // Painter order only in 3D: at top-down, insertion order (files in
    // payload order, then symbols) reproduces the pre-3D draw order exactly.
    if (!cull2d) drawList.sort((a, b) => a.depth - b.depth);
    let minDepth = Infinity, maxDepth = -Infinity;
    for (const item of drawList) {
      minDepth = Math.min(minDepth, item.depth);
      maxDepth = Math.max(maxDepth, item.depth);
    }
    if (minDepth > maxDepth) { minDepth = 0; maxDepth = 1; }
    const depthSpan = Math.max(maxDepth - minDepth, 1e-9);
    // Clamp: edge endpoints can sit outside the visible depth range (culled
    // nodes, or symbols excluded during degrade drags); out-of-range
    // globalAlpha assignments are silently ignored by Canvas.
    const depthFade = (d) => cull2d ? 1 : Math.min(Math.max(0.45 + 0.55 * ((d - minDepth) / depthSpan), 0), 1);

    const drawFile = (f, [sx, sy, depth]) => {
      const baseColor = dirColor.get(f.dir.split("/")[0] || ".") ?? "#7aa2f7";
      const color = f.id === state.selectedFile ? "#ffffff"
        : state.callerFiles.has(f.id) ? CALLER_COLOR
          : state.calleeFiles.has(f.id) ? CALLEE_COLOR : baseColor;
      const related = state.relatedFiles.has(f.id);
      ctx.globalAlpha = (dimOthers ? (related ? 0.95 : 0.12) : 1) * depthFade(depth);
      if (state.expanded.has(f.id)) {
        const rx = f.r * state.k;
        // Floor the squashed axis only when tilted; at pitch 0 the ellipse
        // must equal the pre-3D circle exactly, even for rx < 1.
        const ry = state.pitch === 0 ? rx : Math.max(rx * Math.cos(state.pitch), 1);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (!state.degrading) {
          ctx.fillStyle = color;
          ctx.font = "12px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(f.name, sx, sy - ry - 6);
        }
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, pr, 0, Math.PI * 2);
        ctx.fill();
        if (state.k >= 0.6 && !state.degrading) {
          ctx.fillStyle = "#c0caf5";
          ctx.font = "11px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(f.name, sx, sy - pr - 5);
        }
      }
    };

    const drawSymbol = (s, [sx, sy, depth]) => {
      const isSelected = state.selected === s.id;
      const isHighlighted = state.highlight.has(s.id);
      ctx.globalAlpha = (dimOthers ? (isSelected || isHighlighted ? 1 : 0.15) : 1) * depthFade(depth);
      ctx.fillStyle = state.callers.has(s.id) ? CALLER_COLOR
        : state.callees.has(s.id) ? CALLEE_COLOR
          : (KIND_COLORS.get(s.kind) ?? "#c0caf5");
      ctx.beginPath();
      ctx.arc(sx, sy, isSelected ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (state.k >= 2.5 || isSelected) {
        ctx.fillStyle = "#c0caf5";
        ctx.font = "10px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(s.name, sx, sy - 8);
      }
    };

    // Aggregated file context follows the same kind toggles as detail edges.
    ctx.lineWidth = 1;
    for (const e of model.fileEdges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = fileById.get(e.source);
      const target = fileById.get(e.target);
      if (!source || !target) continue;
      if (!visible(source, source.r) && !visible(target, target.r)) continue;
      const [sx, sy, sd] = P(source);
      const [tx, ty, td] = P(target);
      const directContext = state.directFileEdges.has(fileEdgeKey(e.source, e.target, e.kind));
      ctx.strokeStyle = EDGE_COLORS.get(e.kind) ?? "#565f89";
      ctx.globalAlpha = (dimOthers ? (directContext ? 0.75 : 0.025) : 0.15) * depthFade((sd + td) / 2);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // Detail edges require both owning files expanded; file<->file stays aggregated.
    for (const e of model.edges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = nodeById.get(e.source);
      const target = nodeById.get(e.target);
      if (!source || !target || (source.kind === "file" && target.kind === "file")) continue;
      if (!state.expanded.has(owningFile(source)) || !state.expanded.has(owningFile(target))) continue;
      if (!visible(source, 20) && !visible(target, 20)) continue;
      const [sx, sy, sd] = P(source);
      const [tx, ty, td] = P(target);
      const selectedCall = e.kind === "calls" && (state.selected === source.id || state.selected === target.id);
      ctx.strokeStyle = selectedCall
        ? (state.selected === target.id ? CALLER_COLOR : CALLEE_COLOR)
        : (EDGE_COLORS.get(e.kind) ?? "#565f89");
      ctx.globalAlpha = (dimOthers ? (selectedCall ? 0.9 : 0.06) : 0.35) * depthFade((sd + td) / 2);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    for (const item of drawList) {
      if (item.isFile) drawFile(item.node, P(item.node));
      else drawSymbol(item.node, P(item.node));
    }
    ctx.globalAlpha = 1;
  }
```

Also note: `visibleWorldRect` and `inRect` stay unchanged above `render` (they serve the 2D fast path).

- [ ] **Step 6: Rewrite pointer interaction (rotate/pan/degrade/cancel/dblclick)**

Replace the whole block from `// ---- interaction ----` through the `wheel` listener's closing `}, { passive: false });` with:

```javascript
  // ---- interaction ----
  const PITCH_MAX = (80 * Math.PI) / 180;
  let dragStart = null, dragged = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragStart = {
      x: e.clientX, y: e.clientY,
      tx: state.tx, ty: state.ty,
      yaw: state.yaw, pitch: state.pitch,
      rotate: state.mode3d && e.button === 0 && !e.shiftKey,
    };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (dragStart.rotate) {
      state.yaw = dragStart.yaw + dx * 0.01;
      state.pitch = Math.min(Math.max(dragStart.pitch + dy * 0.01, 0), PITCH_MAX);
      state.degrading = dragged;
    } else {
      state.tx = dragStart.tx + dx;
      state.ty = dragStart.ty + dy;
    }
    state.pickDirty = true;
    state.dirty = true;
  });
  const endDrag = (e, allowClick) => {
    if (dragStart && allowClick && !dragged) onClick(e.clientX, e.clientY);
    // Same guard as the toggle: plain clicks (or drags ending exactly
    // top-down) must not clobber the remembered 3D tilt.
    if (dragStart?.rotate && !topDown()) state.camera3d = { yaw: state.yaw, pitch: state.pitch };
    dragStart = null;
    state.degrading = false;
    state.dirty = true;
  };
  canvas.addEventListener("pointerup", (e) => endDrag(e, true));
  canvas.addEventListener("pointercancel", (e) => endDrag(e, false));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("dblclick", (e) => {
    // Only empty space resets the camera: double-clicking a node is
    // navigation (its two click events already expanded/selected it).
    if (nearestSymbol(e.clientX, e.clientY, 8)) return;
    for (const f of files) {
      const [fx, fy] = project(f, state);
      const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
      if (Math.hypot(fx - e.clientX, fy - e.clientY) <= pr + 2) return;
    }
    state.yaw = 0;
    state.pitch = 0;
    state.camera3d = { yaw: 0, pitch: Math.PI / 4 };
    fitToContent();
    state.pickDirty = true;
    state.dirty = true;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    if (topDown()) {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      state.k = Math.min(Math.max(state.k * factor, 0.05), 40);
      state.tx = e.clientX - wx * state.k;
      state.ty = e.clientY - wy * state.k;
    } else {
      // No exact inverse under rotation: zoom around the viewport center.
      const cx = vw / 2, cy = vh / 2;
      const wx = (cx - state.tx) / state.k;
      const wy = (cy - state.ty) / state.k;
      state.k = Math.min(Math.max(state.k * factor, 0.05), 40);
      state.tx = cx - wx * state.k;
      state.ty = cy - wy * state.k;
    }
    state.pickDirty = true;
    state.dirty = true;
  }, { passive: false });
```

- [ ] **Step 7: Screen-space `onClick` with elliptical ring hit**

Replace the entire `onClick` function with:

```javascript
  function onClick(sx, sy) {
    const sym = nearestSymbol(sx, sy, 8);
    if (sym) {
      selectSymbol(sym);
      return;
    }
    let hit = null;
    for (const f of files) {
      const [fx, fy] = project(f, state);
      const distance = Math.hypot(fx - sx, fy - sy);
      if (state.expanded.has(f.id)) {
        const rx = f.r * state.k;
        const ry = state.pitch === 0 ? rx : Math.max(rx * Math.cos(state.pitch), 1);
        const norm = ((sx - fx) / rx) ** 2 + ((sy - fy) / ry) ** 2;
        if (Math.abs(Math.sqrt(norm) - 1) * Math.min(rx, ry) <= 8) {
          hit = f;
          break;
        }
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        if (distance <= pr + 2) {
          hit = f;
          break;
        }
      }
    }
    if (hit) {
      if (state.expanded.has(hit.id)) state.expanded.delete(hit.id);
      else state.expanded.add(hit.id);
      clearSelection();
      rebuildPickIndex();
      return;
    }
    clearSelection();
  }
```

- [ ] **Step 8: Rotated `zoomTo`**

Replace the body of `zoomTo` with:

```javascript
  function zoomTo(node) {
    state.k = 3;
    const [px, py] = rotate(node.x, node.y, node.z ?? 0, state.yaw, state.pitch);
    state.tx = vw / 2 - px * state.k;
    state.ty = vh / 2 - py * state.k;
    state.pickDirty = true;
    state.dirty = true;
  }
```

- [ ] **Step 9: HUD `3D` toggle button**

Immediately after the edge-kind toggle loop (after the closing `}` of `for (const kind of EDGE_KINDS) { … }`), add:

```javascript
  const modeButton = document.createElement("button");
  modeButton.id = "mode3d";
  modeButton.type = "button";
  modeButton.textContent = "3D";
  modeButton.title = "Toggle rotatable 3D overview";
  modeButton.setAttribute("aria-pressed", "false");
  modeButton.addEventListener("click", () => {
    state.mode3d = !state.mode3d;
    modeButton.setAttribute("aria-pressed", String(state.mode3d));
    if (state.mode3d) {
      state.yaw = state.camera3d.yaw;
      state.pitch = state.camera3d.pitch;
    } else {
      // Only remember angles worth restoring: a top-down camera (e.g. right
      // after a dblclick reset) must not clobber the remembered 3D tilt.
      if (!topDown()) state.camera3d = { yaw: state.yaw, pitch: state.pitch };
      state.yaw = 0;
      state.pitch = 0;
    }
    fitToContent();
    state.pickDirty = true;
    state.dirty = true;
  });
  document.getElementById("hud").append(modeButton);
```

- [ ] **Step 10: Button CSS in `lib/emit.mjs`**

In the `CSS` template string, after the `#toggles label { … }` line, add:

```css
#hud button { background: #24283b; color: #c0caf5; border: 1px solid #3b4261; border-radius: 4px; padding: 4px 8px; cursor: pointer; }
#hud button[aria-pressed="true"] { border-color: #7aa2f7; color: #7dcfff; }
```

- [ ] **Step 11: README**

In `packages/codegraph-viz/README.md`, replace the paragraph starting "Requires a project already indexed" with:

```markdown
Requires a project already indexed with `codegraph init -i`. Opens at the
file level; click a file to expand its symbols, click a symbol for its
details and caller/callee highlights, search with the box top-left, toggle
edge kinds in the HUD. ESC clears selection, then collapses all files.

Toggle **3D** in the HUD for a rotatable overview: drag to orbit,
Shift+drag or right-drag to pan, double-click to reset the camera. The
third dimension encodes directory depth — deeply nested files sink below
top-level code, and heavily connected files drift toward each other's
layers.
```

- [ ] **Step 12: Verify syntax and suite**

Run: `cd packages/codegraph-viz && node --check viewer/viewer.js && npm test`
Expected: no syntax error; `ℹ tests 35`, `ℹ pass 35`, `ℹ fail 0`

- [ ] **Step 13: Commit**

```bash
git add packages/codegraph-viz/viewer/viewer.js packages/codegraph-viz/lib/emit.mjs packages/codegraph-viz/README.md
git commit -m "feat(codegraph-viz): add rotatable 3d overview to viewer"
```

---

### Task 5: Full verification and browser smoke

**Files:**
- Create (temporary, uncommitted): `/tmp/codegraph-viz-3d-smoke.cjs`

**Interfaces:**
- Consumes: all previous tasks; the Nix wrapper `.#codegraph-viz`; the real index at `/tmp/cg-roche`.
- Produces: verification evidence; `/tmp/cg-roche-graph.html` regenerated with z + 3D viewer; `/tmp/cg-roche-graph-3d-proof.png`.

- [ ] **Step 1: Package suite and syntax**

Run: `cd packages/codegraph-viz && npm test && node --check viewer/viewer.js`
Expected: `ℹ tests 35`, `ℹ pass 35`, `ℹ fail 0`; no syntax error.

- [ ] **Step 2: Nix runtime and flake checks**

Run from the worktree root:

```sh
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs
```

Expected: exit 0; `all checks passed!`

- [ ] **Step 3: Regenerate the real artifact**

Run from the worktree root:

```sh
nix build .#codegraph-viz
result/bin/codegraph-viz /tmp/cg-roche -o /tmp/cg-roche-graph.html
node --input-type=module -e '
  const { extractPayload } = await import("./packages/codegraph-viz/lib/emit.mjs");
  const fs = await import("node:fs");
  const m = extractPayload(fs.readFileSync("/tmp/cg-roche-graph.html", "utf8"));
  const bad = m.nodes.filter((n) => !Number.isFinite(n.z));
  console.log(JSON.stringify({ nodes: m.nodes.length, zFinite: m.nodes.length - bad.length }));
  if (bad.length) process.exit(1);
'
```

Expected: `zFinite` equals `nodes` (4361 for the reference index).

- [ ] **Step 4: Write the 3D browser smoke harness**

Write `/tmp/codegraph-viz-3d-smoke.cjs`:

```javascript
// codegraph-viz 3D browser smoke (temporary harness; not committed).
const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const REPO = "/home/roche/projects/pi/roche-pi/.worktrees/codegraph-viz-3d";
const HTML = "/tmp/cg-roche-graph.html";
const PITCH_ON = Math.PI / 4;
const VW = 1440, VH = 1000;

function addPlaywrightPath() {
  const hits = execSync("ls -d /nix/store/*playwright*/lib/node_modules 2>/dev/null || true")
    .toString().trim().split("\n").filter(Boolean);
  if (hits.length === 0) throw new Error("playwright not found in /nix/store");
  for (const p of hits.reverse()) module.paths.unshift(p);
}

async function canvasHash(page) {
  const dataUrl = await page.evaluate(() => document.querySelector("#graph").toDataURL());
  return createHash("sha256").update(dataUrl).digest("hex");
}

const settle = (page) => page.waitForTimeout(400);
const pr = (f) => 4 + 3 * Math.sqrt(Math.max(f.size, 1));

function fitCamera(files, yaw, pitch, rotate) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of files) {
    const [px, py] = rotate(f.x, f.y, f.z ?? 0, yaw, pitch);
    minX = Math.min(minX, px - f.r); maxX = Math.max(maxX, px + f.r);
    minY = Math.min(minY, py - f.r); maxY = Math.max(maxY, py + f.r);
  }
  const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
  const k = Math.min(VW / w, VH / h) * 0.9;
  return { yaw, pitch, k, tx: VW / 2 - ((minX + maxX) / 2) * k, ty: VH / 2 - ((minY + maxY) / 2) * k };
}

function bestSeparated(symbols, cam, project, excludeId = null) {
  const placed = symbols.filter((s) => s.id !== excludeId).map((s) => ({ s, p: project(s, cam) }));
  let best = null;
  for (const a of placed) {
    const others = placed.filter((b) => b.s.id !== a.s.id);
    if (others.length === 0) continue;
    const nearest = Math.min(...others.map((b) => Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1])));
    if (!best || nearest > best.nearest) best = { ...a, nearest };
  }
  return best && best.nearest >= 12 ? best : null;
}

async function main() {
  addPlaywrightPath();
  const { chromium } = require("@playwright/test");
  const { extractPayload } = await import(pathToFileURL(path.join(REPO, "packages/codegraph-viz/lib/emit.mjs")).href);
  const { rotate, project } = await import(pathToFileURL(path.join(REPO, "packages/codegraph-viz/lib/projection.mjs")).href);
  const html = await fsp.readFile(HTML, "utf8");
  const model = extractPayload(html);
  const files = model.nodes.filter((n) => n.kind === "file");
  assert(files.every((f) => Number.isFinite(f.z)), "payload files carry finite z");

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: VW, height: VH } });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    await page.goto(pathToFileURL(HTML).href, { waitUntil: "load" });
    await page.waitForFunction(() => document.querySelector("#footer")?.textContent.includes("nodes"));
    await settle(page);

    const boot = await canvasHash(page);
    await page.locator("#mode3d").click();
    await settle(page);
    const tilted = await canvasHash(page);
    assert.notEqual(tilted, boot, "3D toggle changes the canvas");

    // Toggle-on camera: yaw 0, pitch 45deg, refit.
    const cam1 = fitCamera(files, 0, PITCH_ON, rotate);
    const candidates = files.filter((f) => f.size >= 2)
      .map((f) => ({ f, p: project(f, cam1) }))
      .filter(({ p }) => p[0] > 120 && p[0] < VW - 460 && p[1] > 120 && p[1] < VH - 120)
      .filter(({ f, p }) => files.every((g) => {
        if (g.id === f.id) return true;
        const q = project(g, cam1);
        return Math.hypot(q[0] - p[0], q[1] - p[1]) > pr(f) + pr(g) + 30;
      }));
    let chosen = null;
    for (const cand of candidates) {
      const syms = model.nodes.filter((n) => n.parent === cand.f.id && n.kind !== "file");
      if (!syms.every((s) => {
        const q = project(s, cam1);
        return Math.hypot(q[0] - cand.p[0], q[1] - cand.p[1]) >= 16;
      })) continue;
      const first = bestSeparated(syms, cam1, project);
      if (first) chosen = { ...cand, syms, sym: first.s, sp: first.p };
      if (chosen) break;
    }
    assert(chosen, "found an isolated file with a well-separated symbol");

    await page.mouse.click(chosen.p[0], chosen.p[1]);
    await settle(page);
    const expanded = await canvasHash(page);
    assert.notEqual(expanded, tilted, "clicking a file in 3D expands it");

    await page.mouse.click(chosen.sp[0], chosen.sp[1]);
    await page.waitForFunction(() => document.querySelector("#sidebar")?.hidden === false);
    assert((await page.locator("#sidebar").textContent()).includes(chosen.sym.name),
      "symbol selectable after 3D projection");

    // Deterministic rotation drag: yaw += 100*0.01, pitch += 60*0.01.
    await page.mouse.move(700, 500);
    await page.mouse.down();
    await page.mouse.move(800, 560, { steps: 5 });
    await page.mouse.up();
    await settle(page);
    const rotatedHash = await canvasHash(page);
    assert.notEqual(rotatedHash, expanded, "rotation drag re-renders");
    const cam2 = { ...cam1, yaw: cam1.yaw + 100 * 0.01, pitch: Math.min(cam1.pitch + 60 * 0.01, 80 * Math.PI / 180) };

    const second = bestSeparated(chosen.syms, cam2, project, chosen.sym.id);
    if (second) {
      await page.mouse.click(second.p[0], second.p[1]);
      await page.waitForFunction(() => document.querySelector("#sidebar")?.hidden === false);
      assert((await page.locator("#sidebar").textContent()).includes(second.s.name),
        "symbol selectable after rotation");
    }
    await page.screenshot({ path: "/tmp/cg-roche-graph-3d-proof.png", fullPage: true });

    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await settle(page);

    // Empty-scan helper for the dblclick reset point.
    const cam0 = fitCamera(files, 0, 0, rotate);
    const isEmpty = (x, y) => {
      for (const cam of [cam2, cam0]) {
        for (const f of files) {
          const q = project(f, cam);
          if (Math.hypot(q[0] - x, q[1] - y) < pr(f) + 12) return false;
        }
      }
      return true;
    };
    let empty = null;
    for (let y = 60; y < VH - 60 && !empty; y += 25) {
      for (let x = 60; x < VW - 460; x += 25) {
        if (isEmpty(x, y)) { empty = { x, y }; break; }
      }
    }
    assert(empty, "found an empty point for dblclick");
    await page.mouse.dblclick(empty.x, empty.y);
    await settle(page);
    const reset = await canvasHash(page);
    assert.equal(reset, boot, "double-click resets to the boot top-down view");

    // Toggle off: restores 2D behavior (camera already reset, so same pixels).
    await page.locator("#mode3d").click();
    await settle(page);
    assert.equal(await page.locator("#mode3d").getAttribute("aria-pressed"), "false", "toggle off updates aria-pressed");
    assert.equal(await canvasHash(page), boot, "toggle off restores the 2D view");

    assert.deepEqual(errors, [], errors.join("\n"));
    await page.close();
    console.log(JSON.stringify({ ok: true, file: chosen.f.name, symbol: chosen.sym.name, empty }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || String(error));
  process.exit(1);
});
```

- [ ] **Step 5: Run the smoke**

Run: `node /tmp/codegraph-viz-3d-smoke.cjs`
Expected: exit 0 with `"ok": true`. If a candidate-search assertion fails on the real model, loosen only the search constants (margins, separation thresholds) — never the camera math.

- [ ] **Step 6: Manual browser smoke (request from user)**

Ask the user to open `/tmp/cg-roche-graph.html` and check: 3D toggle tilts the graph into depth layers; drag orbits smoothly; Shift+drag/right-drag pans; wheel zooms; clicking files/symbols works while tilted; edge toggles still filter; double-click resets; ESC behavior unchanged.

- [ ] **Step 7: Final repository gate**

Run: `cd /home/roche/projects/pi/roche-pi/.worktrees/codegraph-viz-3d && git status -sb && git diff --check && git diff --cached --check`
Expected: clean worktree on `add-codegraph-viz-3d`; no whitespace errors. This task changes no tracked files (no commit).

---

## Self-Review Notes (already applied)

- Spec §1 (depth pass) → Task 1; §2 (projection) → Task 2; §3 (viewer) → Task 4; §4 (payload/CLI, no flags) → Tasks 1+3+README in 4; §5 (inlining) → Task 3; §6 (error handling) → Task 1 clamps/normalization + Task 3 throw; §7 (testing) → per-task tests + Task 5 smoke.
- Type consistency: `assignDepth(nodes, fileEdges)`, `rotate(x, y, z, yaw, pitch) → [x1, y2, z2]`, `project(node, cam) → [sx, sy, depth]`, `inlineViewerSources(projectionJs, viewerJs)` used identically across tasks.
- Min-depth normalization in Task 1 is what makes the spec's "all-same-depth → z = 0" literally true; the Task 1 test pins it.
