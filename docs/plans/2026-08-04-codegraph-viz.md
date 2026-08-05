# codegraph-viz Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `codegraph-viz`, a zero-dependency Node CLI that turns a CodeGraph index (`.codegraph/codegraph.db`) into a single self-contained interactive HTML graph viewer.

**Architecture:** `viz.mjs` orchestrates three focused modules — `lib/extract.mjs` (read-only SQLite → graph model), `lib/layout.mjs` (deterministic seeded two-phase force layout), `lib/emit.mjs` (gzip+base64 payload → one `.html` with embedded `viewer/viewer.js`). The browser viewer is hand-rolled canvas JS: pan/zoom, quadtree picking, lazy file→symbol expansion, sidebar inspection, search, edge-kind toggles. No simulation runs in the browser.

**Tech Stack:** Node 24 (`node:sqlite`, `node:zlib`, `node:test`), vanilla browser JS, Nix (`runCommand` wrapper, flake-parts module).

Spec: `docs/specs/2026-08-04-codegraph-viz-design.md` (committed on this branch).

## Global Constraints

- Node **24+** for any command running the package or its tests (`node:sqlite` unflagged). Local `node` is v24.15.0 — plain `node --test` works.
- **Zero runtime npm dependencies** — Node stdlib only. No bundler, no CDN.
- Commits: Conventional Commits (`feat(codegraph-viz): …`, `test(codegraph-viz): …`), no sign-offs.
- New files must be `git add`-ed **before** any `nix build`/`nix flake check` (git-backed flake ignores untracked files).
- Format Nix with `nixfmt` (rfc-style) before committing Nix changes.
- CLI error behavior verbatim from spec: missing DB → `no CodeGraph index at <path> — run \`codegraph init -i\` first`; missing table → `index at <path> is missing table '<t>'`; empty → `index at <path> is empty`; over `--max-nodes` without `--force` → exit 1 with count and hint. All errors to stderr, exit 1.
- Payload contract (extract → layout → emit → viewer share this shape):

```js
{
  meta: { project, nodeCount, edgeCount, fileCount, generatedAt }, // generatedAt: ISO string
  nodes: [{ id, kind, name, qualifiedName, file, dir, parent, line, size, x, y, r? }],
  //   file nodes: kind "file", parent null, size = symbol count, r = disc radius (layout adds x,y,r)
  //   symbol nodes: parent = file node id, size = 1 (layout adds x,y)
  //   optional fields signature/docstring present only when non-empty (docstring trimmed to 500 chars)
  edges: [{ source, target, kind }],              // symbol-level, kinds: calls|references|imports|instantiates|implements
  fileEdges: [{ source, target, kind, weight }],  // cross-file only, weight = aggregated count
}
```

## File Structure

```
packages/codegraph-viz/
├── package.json         { "type": "module" }, test script: node --test test/
├── viz.mjs              CLI entry: args, orchestration, error handling
├── lib/extract.mjs      extractGraph(projectPath) → model; buildModel (pure, exported for tests)
├── lib/layout.mjs       computeLayout(model) → mutates nodes with x,y,r
├── lib/emit.mjs         buildHtml(model, viewerJs) → string; extractPayload(html) → model (test helper)
├── viewer/viewer.js     browser viewer, embedded verbatim into HTML
└── test/
    ├── fixture.mjs      createFixtureProject() → { dir } with a known .codegraph/codegraph.db
    ├── extract.test.mjs
    ├── layout.test.mjs
    ├── emit.test.mjs
    └── cli.test.mjs
```

Nix wiring: `nix/packages/codegraph-viz.nix` (new), `modules/packages/codegraph-viz.nix` (new: package + `codegraph-viz-tests` check), `modules/devshells/default.nix` (edit), `modules/home/pi.nix` (edit: `installCodegraphViz`).

---

### Task 1: Package scaffold + fixture DB builder

**Files:**
- Create: `packages/codegraph-viz/package.json`
- Create: `packages/codegraph-viz/test/fixture.mjs`
- Test: `packages/codegraph-viz/test/extract.test.mjs`

**Interfaces:**
- Produces: `createFixtureProject(): { dir }` — creates a temp project with `.codegraph/codegraph.db` containing 5 node rows (2 files, 3 symbols) and 6 edge rows (3 `contains`, 3 kept kinds). Used by Tasks 2, 3, 4, 6.

- [ ] **Step 1: Write the failing test**

`packages/codegraph-viz/test/extract.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createFixtureProject } from "./fixture.mjs";

test("fixture builds a codegraph-shaped DB", () => {
  const { dir } = createFixtureProject();
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"), { readOnly: true });
  const nodeCount = db.prepare("SELECT COUNT(*) AS c FROM nodes").get().c;
  const edgeCount = db.prepare("SELECT COUNT(*) AS c FROM edges").get().c;
  db.close();
  assert.equal(nodeCount, 5);
  assert.equal(edgeCount, 6);
});
```

`packages/codegraph-viz/package.json`:

```json
{
  "name": "codegraph-viz",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: FAIL — `Cannot find module './fixture.mjs'`

- [ ] **Step 3: Implement the fixture**

`packages/codegraph-viz/test/fixture.mjs`:

```js
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Builds a minimal .codegraph/codegraph.db matching the schema subset
// lib/extract.mjs reads. 5 nodes: 2 files (src/a.ts, src/b.ts) and 3 symbols
// (fn:greet in a.ts; fn:main and cls:Greeter in b.ts). 6 edges: 3 contains
// plus calls (main→greet, cross-file), instantiates (main→Greeter, intra-file),
// references (Greeter→greet, cross-file). fn:main's docstring is 600 chars to
// exercise trimming.
export function createFixtureProject() {
  const dir = mkdtempSync(join(tmpdir(), "cgv-fixture-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, qualified_name TEXT,
      file_path TEXT, language TEXT, start_line INTEGER, end_line INTEGER,
      signature TEXT, docstring TEXT
    );
    CREATE TABLE edges (
      id INTEGER PRIMARY KEY, source TEXT NOT NULL, target TEXT NOT NULL,
      kind TEXT NOT NULL
    );
  `);
  const ins = db.prepare(`INSERT INTO nodes
    (id, kind, name, qualified_name, file_path, language, start_line, end_line, signature, docstring)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  ins.run("file:src/a.ts", "file", "a.ts", "src/a.ts", "src/a.ts", "typescript", 1, 4, null, null);
  ins.run("file:src/b.ts", "file", "b.ts", "src/b.ts", "src/b.ts", "typescript", 1, 9, null, null);
  ins.run("fn:greet", "function", "greet", "greet", "src/a.ts", "typescript", 1, 3, "greet(name: string): string", "Says hi.");
  ins.run("fn:main", "function", "main", "main", "src/b.ts", "typescript", 1, 4, "main(): string", "x".repeat(600));
  ins.run("cls:Greeter", "class", "Greeter", "Greeter", "src/b.ts", "typescript", 5, 9, null, null);
  const eins = db.prepare("INSERT INTO edges (source, target, kind) VALUES (?, ?, ?)");
  eins.run("file:src/a.ts", "fn:greet", "contains");
  eins.run("file:src/b.ts", "fn:main", "contains");
  eins.run("file:src/b.ts", "cls:Greeter", "contains");
  eins.run("fn:main", "fn:greet", "calls");
  eins.run("fn:main", "cls:Greeter", "instantiates");
  eins.run("cls:Greeter", "fn:greet", "references");
  db.close();
  return { dir };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 1 test

- [ ] **Step 5: Commit**

```bash
git add packages/codegraph-viz/package.json packages/codegraph-viz/test/fixture.mjs packages/codegraph-viz/test/extract.test.mjs
git commit -m "test(codegraph-viz): scaffold package with fixture DB builder"
```

---

### Task 2: extract.mjs — graph model from SQLite

**Files:**
- Create: `packages/codegraph-viz/lib/extract.mjs`
- Test: `packages/codegraph-viz/test/extract.test.mjs` (append)

**Interfaces:**
- Consumes: `createFixtureProject()` from Task 1.
- Produces:
  - `extractGraph(projectPath: string): Model` — opens `.codegraph/codegraph.db` read-only, validates schema, returns the payload-contract model. Throws `Error` with spec-verbatim messages.
  - `buildModel(projectPath: string, nodeRows: Row[], edgeRows: EdgeRow[]): Model` — pure transform, exported for direct testing.

- [ ] **Step 1: Write the failing tests (model shape, hierarchy, trim)**

Append to `test/extract.test.mjs`:

```js
import { basename } from "node:path";
import { extractGraph } from "../lib/extract.mjs";

test("extractGraph returns the payload-contract model", () => {
  const { dir } = createFixtureProject();
  const model = extractGraph(dir);
  assert.equal(model.meta.nodeCount, 5);
  assert.equal(model.meta.fileCount, 2);
  assert.equal(model.meta.edgeCount, 3); // contains edges dropped
  assert.equal(model.meta.project, basename(dir));
  assert.ok(typeof model.meta.generatedAt === "string");

  const greet = model.nodes.find((n) => n.id === "fn:greet");
  assert.equal(greet.parent, "file:src/a.ts");
  assert.equal(greet.file, "src/a.ts");
  assert.equal(greet.dir, "src");
  assert.equal(greet.kind, "function");
  assert.equal(greet.line, 1);
  assert.equal(greet.signature, "greet(name: string): string");
  assert.equal(greet.docstring, "Says hi.");
  assert.equal(greet.size, 1);

  const fileA = model.nodes.find((n) => n.id === "file:src/a.ts");
  assert.equal(fileA.kind, "file");
  assert.equal(fileA.parent, null);
  assert.equal(fileA.size, 1); // one symbol
  const fileB = model.nodes.find((n) => n.id === "file:src/b.ts");
  assert.equal(fileB.size, 2);

  const main = model.nodes.find((n) => n.id === "fn:main");
  assert.equal(main.docstring.length, 500); // trimmed from 600

  const bare = model.nodes.find((n) => n.id === "cls:Greeter");
  assert.equal("signature" in bare, false); // empty fields omitted
});

test("fileEdges aggregate only cross-file edges with weights", () => {
  const { dir } = createFixtureProject();
  const model = extractGraph(dir);
  const key = (e) => `${e.source}|${e.target}|${e.kind}|${e.weight}`;
  const keys = model.fileEdges.map(key).sort();
  assert.deepEqual(keys, [
    "file:src/b.ts|file:src/a.ts|calls|1",
    "file:src/b.ts|file:src/a.ts|references|1",
  ]);
  // fn:main→cls:Greeter is intra-file: present in edges, absent from fileEdges
  assert.ok(model.edges.some((e) => e.kind === "instantiates"));
  assert.ok(!model.fileEdges.some((e) => e.kind === "instantiates"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: FAIL — `Cannot find module '../lib/extract.mjs'`

- [ ] **Step 3: Implement extract.mjs**

`packages/codegraph-viz/lib/extract.mjs`:

```js
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

export const KEPT_EDGE_KINDS = new Set(["calls", "references", "imports", "instantiates", "implements"]);
const DOCSTRING_MAX = 500;

export function extractGraph(projectPath) {
  const dbPath = join(projectPath, ".codegraph", "codegraph.db");
  if (!existsSync(dbPath)) {
    throw new Error(`no CodeGraph index at ${projectPath} — run \`codegraph init -i\` first`);
  }
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(`cannot open ${dbPath}: ${err.message}`);
  }
  try {
    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
    );
    for (const table of ["nodes", "edges"]) {
      if (!tables.has(table)) throw new Error(`index at ${projectPath} is missing table '${table}'`);
    }
    const nodeRows = db
      .prepare("SELECT id, kind, name, qualified_name, file_path, start_line, signature, docstring FROM nodes")
      .all();
    if (nodeRows.length === 0) throw new Error(`index at ${projectPath} is empty`);
    const edgeRows = db.prepare("SELECT source, target, kind FROM edges").all();
    return buildModel(projectPath, nodeRows, edgeRows);
  } finally {
    db.close();
  }
}

export function buildModel(projectPath, nodeRows, edgeRows) {
  const fileIdByPath = new Map();
  for (const row of nodeRows) {
    if (row.kind === "file") fileIdByPath.set(row.file_path, row.id);
  }

  const nodes = [];
  const symbolCountByFile = new Map();

  // Symbols first. A symbol whose file_path has no file node gets a
  // synthesized file node (appended to nodeRows; the for…of below visits it
  // in the file pass because arrays iterate appended elements).
  for (const row of nodeRows) {
    if (row.kind === "file") continue;
    let fileId = fileIdByPath.get(row.file_path);
    if (!fileId) {
      fileId = `file:${row.file_path}`;
      fileIdByPath.set(row.file_path, fileId);
      nodeRows.push({
        id: fileId, kind: "file", name: basename(row.file_path),
        qualified_name: row.file_path, file_path: row.file_path,
        start_line: 1, signature: null, docstring: null,
      });
    }
    symbolCountByFile.set(fileId, (symbolCountByFile.get(fileId) ?? 0) + 1);
    nodes.push({
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name ?? row.name,
      file: row.file_path,
      dir: dirOf(row.file_path),
      parent: fileId,
      line: row.start_line ?? null,
      ...(row.signature ? { signature: row.signature } : {}),
      ...(row.docstring ? { docstring: row.docstring.slice(0, DOCSTRING_MAX) } : {}),
      size: 1,
    });
  }

  for (const row of nodeRows) {
    if (row.kind !== "file") continue;
    nodes.push({
      id: row.id,
      kind: "file",
      name: row.name,
      qualifiedName: row.qualified_name,
      file: row.file_path,
      dir: dirOf(row.file_path),
      parent: null,
      line: null,
      size: symbolCountByFile.get(row.id) ?? 0,
    });
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = [];
  const fileEdgeWeights = new Map();
  for (const row of edgeRows) {
    if (!KEPT_EDGE_KINDS.has(row.kind)) continue;
    const source = nodeById.get(row.source);
    const target = nodeById.get(row.target);
    if (!source || !target) continue; // edge referencing a pruned/unknown node
    edges.push({ source: row.source, target: row.target, kind: row.kind });
    const sf = source.kind === "file" ? source.id : source.parent;
    const tf = target.kind === "file" ? target.id : target.parent;
    if (sf !== tf) {
      const key = `${sf} ${tf} ${row.kind}`;
      fileEdgeWeights.set(key, (fileEdgeWeights.get(key) ?? 0) + 1);
    }
  }
  const fileEdges = [...fileEdgeWeights].map(([key, weight]) => {
    const [source, target, kind] = key.split(" ");
    return { source, target, kind, weight };
  });

  const fileCount = nodes.filter((n) => n.kind === "file").length;
  return {
    meta: {
      project: basename(projectPath),
      nodeCount: nodes.length,
      edgeCount: edges.length,
      fileCount,
      generatedAt: new Date().toISOString(),
    },
    nodes,
    edges,
    fileEdges,
  };
}

function dirOf(filePath) {
  const idx = filePath.lastIndexOf("/");
  if (idx === -1) return ".";
  return filePath.slice(0, idx) || "/";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 3 tests

- [ ] **Step 5: Write the failing error-path tests**

Append to `test/extract.test.mjs`:

```js
import { DatabaseSync as Db2 } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("missing index → spec-verbatim error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-empty-"));
  assert.throws(() => extractGraph(dir), /no CodeGraph index at .+ — run `codegraph init -i` first/);
});

test("missing tables → names the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-notables-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new Db2(join(dir, ".codegraph", "codegraph.db"));
  db.exec("CREATE TABLE nodes (id TEXT)");
  db.close();
  assert.throws(() => extractGraph(dir), /missing table 'edges'/);
});

test("empty index → spec-verbatim error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-norows-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new Db2(join(dir, ".codegraph", "codegraph.db"));
  db.exec("CREATE TABLE nodes (id TEXT); CREATE TABLE edges (source TEXT)");
  db.close();
  assert.throws(() => extractGraph(dir), /is empty/);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 6 tests (the implementation from Step 3 already handles these; if the `missing tables` test fails because the SELECT on a bare `nodes(id)` table errors first, adjust the implementation to validate tables **before** any data query — it already does).

- [ ] **Step 7: Commit**

```bash
git add packages/codegraph-viz/lib/extract.mjs packages/codegraph-viz/test/extract.test.mjs
git commit -m "feat(codegraph-viz): extract graph model from codegraph index"
```

---

### Task 3: layout.mjs — deterministic two-phase layout

**Files:**
- Create: `packages/codegraph-viz/lib/layout.mjs`
- Test: `packages/codegraph-viz/test/layout.test.mjs`

**Interfaces:**
- Consumes: model from `extractGraph` (Task 2).
- Produces: `computeLayout(model): model` — mutates `model.nodes` in place, adding absolute `x`, `y` to every node and `r` (disc radius) to file nodes. Deterministic: same model → identical coordinates.

- [ ] **Step 1: Write the failing tests**

`packages/codegraph-viz/test/layout.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureProject } from "./fixture.mjs";
import { extractGraph } from "../lib/extract.mjs";
import { computeLayout } from "../lib/layout.mjs";

test("layout is deterministic", () => {
  const a = computeLayout(extractGraph(createFixtureProject().dir));
  const b = computeLayout(extractGraph(createFixtureProject().dir));
  const posA = a.nodes.map((n) => [n.x, n.y]);
  const posB = b.nodes.map((n) => [n.x, n.y]);
  assert.deepEqual(posA, posB);
});

test("every node gets finite coordinates; files get a radius", () => {
  const model = computeLayout(extractGraph(createFixtureProject().dir));
  for (const n of model.nodes) {
    assert.ok(Number.isFinite(n.x), `${n.id} x`);
    assert.ok(Number.isFinite(n.y), `${n.id} y`);
    if (n.kind === "file") assert.ok(n.r > 0, `${n.id} r`);
  }
});

test("symbols stay inside their file disc", () => {
  const model = computeLayout(extractGraph(createFixtureProject().dir));
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  for (const n of model.nodes) {
    if (n.kind === "file") continue;
    const f = byId.get(n.parent);
    const d = Math.hypot(n.x - f.x, n.y - f.y);
    assert.ok(d <= f.r + 1e-9, `${n.id} within ${f.id} disc (d=${d}, r=${f.r})`);
  }
});

test("degenerate single-file index does not blow up", () => {
  const model = computeLayout({
    meta: { project: "x", nodeCount: 2, edgeCount: 0, fileCount: 1, generatedAt: "" },
    nodes: [
      { id: "file:solo.ts", kind: "file", name: "solo.ts", qualifiedName: "solo.ts", file: "solo.ts", dir: ".", parent: null, line: null, size: 1 },
      { id: "fn:solo", kind: "function", name: "solo", qualifiedName: "solo", file: "solo.ts", dir: ".", parent: "file:solo.ts", line: 1, size: 1 },
    ],
    edges: [],
    fileEdges: [],
  });
  const [f, s] = model.nodes;
  assert.ok(Number.isFinite(f.x) && Number.isFinite(f.y));
  assert.equal(s.x, f.x);
  assert.equal(s.y, f.y);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: FAIL — `Cannot find module '../lib/layout.mjs'`

- [ ] **Step 3: Implement layout.mjs**

`packages/codegraph-viz/lib/layout.mjs`:

```js
// Deterministic two-phase force layout.
// Phase 1 lays out file centers over aggregated file→file edges.
// Phase 2 lays out each file's symbols in that file's local frame.
// All randomness comes from one seeded PRNG; tick budgets are fixed.

export function computeLayout(model) {
  const rng = mulberry32(0xc0ffee);
  const files = model.nodes.filter((n) => n.kind === "file");

  // Phase 1: file centers
  const fileBodies = files.map((f) => ({
    id: f.id,
    x: (rng() - 0.5) * 400,
    y: (rng() - 0.5) * 400,
    vx: 0, vy: 0,
    mass: 1 + f.size,
  }));
  const fileLinks = model.fileEdges.map((fe) => ({
    source: fe.source, target: fe.target, weight: fe.weight,
  }));
  simulate(fileBodies, fileLinks, {
    ticks: 400, charge: -300, linkDistance: 120, linkStrength: 0.03, gravity: 0.01, rng,
  });
  const filePos = new Map(fileBodies.map((b) => [b.id, b]));

  // Phase 2: per-file symbol layouts
  const symbolsByParent = new Map();
  for (const n of model.nodes) {
    if (n.kind === "file") continue;
    if (!symbolsByParent.has(n.parent)) symbolsByParent.set(n.parent, []);
    symbolsByParent.get(n.parent).push(n);
  }
  for (const f of files) {
    const center = filePos.get(f.id);
    const r = fileRadius(f.size);
    f.x = center.x; f.y = center.y; f.r = r;
    const syms = symbolsByParent.get(f.id) ?? [];
    if (syms.length === 0) continue;
    if (syms.length === 1) { syms[0].x = center.x; syms[0].y = center.y; continue; }
    const idSet = new Set(syms.map((s) => s.id));
    const localLinks = model.edges
      .filter((e) => e.kind === "calls" && idSet.has(e.source) && idSet.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, weight: 1 }));
    const bodies = syms.map((s) => ({
      id: s.id, x: (rng() - 0.5) * r, y: (rng() - 0.5) * r, vx: 0, vy: 0, mass: 1,
    }));
    simulate(bodies, localLinks, {
      ticks: 150, charge: -60, linkDistance: r * 0.4, linkStrength: 0.05, gravity: 0.2, rng,
    });
    // Clamp into the disc (0.9 r)
    let maxD = 0;
    for (const b of bodies) maxD = Math.max(maxD, Math.hypot(b.x, b.y));
    const scale = maxD > 0 ? Math.min(1, (r * 0.9) / maxD) : 1;
    const posById = new Map(bodies.map((b) => [b.id, b]));
    for (const s of syms) {
      const b = posById.get(s.id);
      s.x = center.x + b.x * scale;
      s.y = center.y + b.y * scale;
    }
  }
  return model;
}

export function fileRadius(symbolCount) {
  return 30 + 14 * Math.sqrt(Math.max(symbolCount, 1));
}

function simulate(bodies, links, { ticks, charge, linkDistance, linkStrength, gravity, rng }) {
  const byId = new Map(bodies.map((b) => [b.id, b]));
  for (let tick = 0; tick < ticks; tick++) {
    const alpha = 1 - tick / ticks;
    applyRepulsion(bodies, charge, alpha);
    for (const link of links) {
      const s = byId.get(link.source);
      const t = byId.get(link.target);
      if (!s || !t) continue;
      let dx = t.x - s.x;
      let dy = t.y - s.y;
      let d = Math.hypot(dx, dy);
      if (d === 0) { dx = (rng() - 0.5) * 0.01; dy = (rng() - 0.5) * 0.01; d = Math.hypot(dx, dy); }
      const force = (d - linkDistance) * linkStrength * Math.min(link.weight ?? 1, 5) * alpha;
      const fx = (dx / d) * force;
      const fy = (dy / d) * force;
      s.vx += fx / s.mass; s.vy += fy / s.mass;
      t.vx -= fx / t.mass; t.vy -= fy / t.mass;
    }
    for (const b of bodies) {
      b.vx -= b.x * gravity * alpha;
      b.vy -= b.y * gravity * alpha;
      b.vx *= 0.6; b.vy *= 0.6; // damping
      const speed = Math.hypot(b.vx, b.vy);
      if (speed > 10) { b.vx = (b.vx / speed) * 10; b.vy = (b.vy / speed) * 10; }
      b.x += b.vx; b.y += b.vy;
    }
  }
}

// Barnes–Hut repulsion over a quadtree with center-of-mass (theta 0.8).
function applyRepulsion(bodies, charge, alpha) {
  if (bodies.length < 2) return;
  const root = buildQuadtree(bodies);
  for (const b of bodies) applyTreeForce(root, b, charge, alpha);
}

function buildQuadtree(bodies) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of bodies) {
    if (b.x < minX) minX = b.x;
    if (b.x > maxX) maxX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.y > maxY) maxY = b.y;
  }
  const size = Math.max(maxX - minX, maxY - minY, 1);
  const root = quad(minX, minY, size);
  for (const b of bodies) insertPoint(root, b);
  computeMass(root);
  return root;
}

function quad(x, y, size) {
  return { x, y, size, body: null, children: null, mass: 0, cx: 0, cy: 0 };
}

function insertPoint(node, body) {
  if (!node.body && !node.children) { node.body = body; return; }
  if (!node.children) {
    const half = node.size / 2;
    node.children = [
      quad(node.x, node.y, half),
      quad(node.x + half, node.y, half),
      quad(node.x, node.y + half, half),
      quad(node.x + half, node.y + half, half),
    ];
    const existing = node.body;
    node.body = null;
    insertPoint(childFor(node, existing), existing);
  }
  insertPoint(childFor(node, body), body);
}

function childFor(node, body) {
  const right = body.x >= node.x + node.size / 2 ? 1 : 0;
  const bottom = body.y >= node.y + node.size / 2 ? 2 : 0;
  return node.children[right + bottom];
}

function computeMass(node) {
  if (!node.children) {
    if (node.body) { node.mass = node.body.mass; node.cx = node.body.x; node.cy = node.body.y; }
    return;
  }
  for (const c of node.children) computeMass(c);
  node.mass = 0; node.cx = 0; node.cy = 0;
  for (const c of node.children) { node.mass += c.mass; node.cx += c.cx * c.mass; node.cy += c.cy * c.mass; }
  if (node.mass > 0) { node.cx /= node.mass; node.cy /= node.mass; }
}

function applyTreeForce(node, body, charge, alpha) {
  const THETA2 = 0.64; // 0.8²
  const stack = [node];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n.mass === 0) continue;
    const dx = n.cx - body.x;
    const dy = n.cy - body.y;
    let d2 = dx * dx + dy * dy;
    if (!n.children) {
      if (n.body === body || d2 === 0) continue;
      repel(body, dx, dy, d2, charge * n.mass, alpha);
      continue;
    }
    if ((n.size * n.size) / Math.max(d2, 1e-6) < THETA2) {
      d2 = Math.max(d2, 4);
      repel(body, dx, dy, d2, charge * n.mass, alpha);
    } else {
      for (const c of n.children) stack.push(c);
    }
  }
}

function repel(body, dx, dy, d2, k, alpha) {
  const d = Math.sqrt(d2);
  const f = (k / d2) * alpha; // k negative → pushes away
  body.vx += (dx / d) * f;
  body.vy += (dy / d) * f;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 10 tests. If `symbols stay inside their file disc` fails marginally, the clamp already scales to `0.9 r` — check that `simulate` ran with the right `r` (bodies start within `±r/2`, gravity keeps them in; the clamp guarantees containment — investigate a real failure rather than loosening the test).

- [ ] **Step 5: Commit**

```bash
git add packages/codegraph-viz/lib/layout.mjs packages/codegraph-viz/test/layout.test.mjs
git commit -m "feat(codegraph-viz): add deterministic two-phase layout"
```

---

### Task 4: emit.mjs — self-contained HTML with gzip payload

**Files:**
- Create: `packages/codegraph-viz/lib/emit.mjs`
- Test: `packages/codegraph-viz/test/emit.test.mjs`

**Interfaces:**
- Consumes: laid-out model (Task 3), viewer source string (Task 5; a stub string suffices for these tests).
- Produces:
  - `buildHtml(model, viewerJs: string): string`
  - `extractPayload(html: string): Model` (used by tests here and in Task 6)

- [ ] **Step 1: Write the failing tests**

`packages/codegraph-viz/test/emit.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureProject } from "./fixture.mjs";
import { extractGraph } from "../lib/extract.mjs";
import { computeLayout } from "../lib/layout.mjs";
import { buildHtml, extractPayload } from "../lib/emit.mjs";

function laidOutModel() {
  return computeLayout(extractGraph(createFixtureProject().dir));
}

test("payload round-trips through gzip+base64", () => {
  const model = laidOutModel();
  const html = buildHtml(model, "/* viewer stub */");
  assert.deepEqual(extractPayload(html), model);
});

test("html contains exactly one payload block and the viewer source", () => {
  const html = buildHtml(laidOutModel(), "/* viewer stub */");
  const blocks = html.match(/<script type="application\/octet-stream" id="payload">/g) ?? [];
  assert.equal(blocks.length, 1);
  assert.ok(html.includes("/* viewer stub */"));
});

test("project name appears in the title, HTML-escaped", () => {
  const model = laidOutModel();
  model.meta.project = 'a<b>"';
  const html = buildHtml(model, "");
  assert.ok(html.includes("<title>codegraph-viz — a&lt;b&gt;&quot;</title>"));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: FAIL — `Cannot find module '../lib/emit.mjs'`

- [ ] **Step 3: Implement emit.mjs**

`packages/codegraph-viz/lib/emit.mjs`:

```js
import { gzipSync, gunzipSync } from "node:zlib";

const PAYLOAD_RE = /<script type="application\/octet-stream" id="payload">\s*([A-Za-z0-9+/=]+)\s*<\/script>/;

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #1a1b26; color: #c0caf5; font: 13px/1.4 system-ui, sans-serif; overflow: hidden; }
#graph { position: fixed; inset: 0; display: block; }
#hud { position: fixed; top: 10px; left: 10px; display: flex; gap: 8px; align-items: center; }
#search { background: #24283b; color: #c0caf5; border: 1px solid #3b4261; border-radius: 4px; padding: 4px 8px; width: 220px; }
#toggles { display: flex; gap: 6px; background: #24283bcc; padding: 4px 8px; border-radius: 4px; }
#toggles label { display: flex; gap: 3px; align-items: center; cursor: pointer; }
#legend { position: fixed; bottom: 28px; left: 10px; background: #24283bcc; padding: 6px 8px; border-radius: 4px; max-width: 260px; }
#legend .sw { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 5px; }
#legend .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
#sidebar { position: fixed; top: 0; right: 0; width: 320px; height: 100vh; overflow-y: auto; background: #1f2335ee; border-left: 1px solid #3b4261; padding: 14px; }
#sidebar h2 { margin: 0 0 4px; font-size: 15px; word-break: break-all; }
#sidebar .kind { color: #7dcfff; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
#sidebar .loc { color: #565f89; margin-bottom: 8px; }
#sidebar pre { background: #24283b; padding: 8px; border-radius: 4px; white-space: pre-wrap; word-break: break-word; }
#footer { position: fixed; bottom: 0; left: 0; right: 0; padding: 4px 10px; background: #1f2335; color: #565f89; font-size: 12px; }
`;

export function buildHtml(model, viewerJs) {
  const payload = gzipSync(JSON.stringify(model), { level: 9 }).toString("base64");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>codegraph-viz — ${escapeHtml(model.meta.project)}</title>
<style>${CSS}</style>
</head>
<body>
<canvas id="graph"></canvas>
<div id="hud">
  <input id="search" type="search" placeholder="Search symbols…" autocomplete="off">
  <div id="toggles"></div>
</div>
<div id="legend"></div>
<aside id="sidebar" hidden></aside>
<footer id="footer"></footer>
<script type="application/octet-stream" id="payload">
${payload}
</script>
<script>
${viewerJs}
</script>
</body>
</html>
`;
}

export function extractPayload(html) {
  const match = html.match(PAYLOAD_RE);
  if (!match) throw new Error("no payload block found");
  return JSON.parse(gunzipSync(Buffer.from(match[1], "base64")).toString("utf8"));
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add packages/codegraph-viz/lib/emit.mjs packages/codegraph-viz/test/emit.test.mjs
git commit -m "feat(codegraph-viz): emit self-contained HTML with gzip payload"
```

---

### Task 5: viewer.js — hand-rolled canvas viewer

**Files:**
- Create: `packages/codegraph-viz/viewer/viewer.js`
- Test: syntax gate (below); browser behavior is manual-smoke per the spec's Testing Value Gate decision.

**Interfaces:**
- Consumes: the payload contract (Global Constraints) from an in-page `#payload` block, inflated via `DecompressionStream("gzip")`.
- Produces: no exports (browser global script). Later tasks rely only on `node --check` passing.

- [ ] **Step 1: Write viewer.js**

`packages/codegraph-viz/viewer/viewer.js` (complete file):

```js
"use strict";

(async function boot() {
  const b64 = document.getElementById("payload").textContent.trim();
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const model = JSON.parse(await new Response(stream).text());
  start(model);
})();

function start(model) {
  const files = model.nodes.filter((n) => n.kind === "file");
  const symbols = model.nodes.filter((n) => n.kind !== "file");
  const fileById = new Map(files.map((f) => [f.id, f]));

  const KIND_COLORS = {
    function: "#7aa2f7", method: "#7aa2f7", class: "#e0af68", struct: "#e0af68",
    interface: "#9ece6a", type_alias: "#9ece6a", variable: "#bb9af7", constant: "#bb9af7",
    property: "#73daca", import: "#565f89",
  };
  const EDGE_COLORS = {
    calls: "#7aa2f7", references: "#9ece6a", imports: "#565f89",
    instantiates: "#e0af68", implements: "#f7768e",
  };
  const EDGE_KINDS = Object.keys(EDGE_COLORS);
  const CALLER_COLOR = "#f7768e";
  const CALLEE_COLOR = "#9ece6a";

  const dirs = [...new Set(files.map((f) => f.dir.split("/")[0] || "."))].sort();
  const dirColor = new Map(dirs.map((d, i) => [d, `hsl(${Math.round((i * 137.5) % 360)},55%,55%)`]));

  const state = {
    expanded: new Set(),
    selected: null,
    highlight: new Set(),
    enabledEdges: new Set(["calls"]),
    matches: [], matchIndex: 0,
    k: 1, tx: 0, ty: 0,
    dirty: true,
  };

  const canvas = document.getElementById("graph");
  const ctx = canvas.getContext("2d");
  let dpr = 1, vw = 0, vh = 0;

  function resize() {
    dpr = globalThis.devicePixelRatio || 1;
    vw = globalThis.innerWidth; vh = globalThis.innerHeight;
    canvas.width = vw * dpr; canvas.height = vh * dpr;
    canvas.style.width = vw + "px"; canvas.style.height = vh + "px";
    state.dirty = true;
  }
  globalThis.addEventListener("resize", resize);
  resize();

  function fitToContent() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of files) {
      minX = Math.min(minX, f.x - f.r); maxX = Math.max(maxX, f.x + f.r);
      minY = Math.min(minY, f.y - f.r); maxY = Math.max(maxY, f.y + f.r);
    }
    const w = Math.max(maxX - minX, 1), h = Math.max(maxY - minY, 1);
    state.k = Math.min(vw / w, vh / h) * 0.9;
    state.tx = vw / 2 - ((minX + maxX) / 2) * state.k;
    state.ty = vh / 2 - ((minY + maxY) / 2) * state.k;
  }
  fitToContent();

  // ---- pick index (point quadtree over symbols of expanded files) ----
  let symbolTree = null;
  function rebuildPickIndex() {
    const pts = symbols.filter((s) => state.expanded.has(s.parent));
    symbolTree = buildPointTree(pts);
    state.dirty = true;
  }
  rebuildPickIndex();

  function buildPointTree(pts) {
    if (pts.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
    }
    const root = { x: minX, y: minY, size: Math.max(maxX - minX, maxY - minY, 1), point: null, children: null };
    for (const p of pts) insertPt(root, p);
    return root;
  }
  function insertPt(node, p) {
    if (!node.point && !node.children) { node.point = p; return; }
    if (!node.children) {
      const h = node.size / 2;
      node.children = [
        { x: node.x, y: node.y, size: h, point: null, children: null },
        { x: node.x + h, y: node.y, size: h, point: null, children: null },
        { x: node.x, y: node.y + h, size: h, point: null, children: null },
        { x: node.x + h, y: node.y + h, size: h, point: null, children: null },
      ];
      const old = node.point; node.point = null;
      insertPt(node, old);
    }
    const right = p.x >= node.x + node.size / 2 ? 1 : 0;
    const bottom = p.y >= node.y + node.size / 2 ? 2 : 0;
    insertPt(node.children[right + bottom], p);
  }
  function nearestSymbol(x, y, maxDist) {
    let best = null, bestD = maxDist;
    (function visit(node) {
      if (!node) return;
      if (x < node.x - bestD || x > node.x + node.size + bestD) return;
      if (y < node.y - bestD || y > node.y + node.size + bestD) return;
      if (node.point) {
        const d = Math.hypot(node.point.x - x, node.point.y - y);
        if (d < bestD) { best = node.point; bestD = d; }
      }
      if (node.children) for (const c of node.children) visit(c);
    })(symbolTree);
    return best;
  }

  // ---- transform helpers ----
  const toWorld = (sx, sy) => [(sx - state.tx) / state.k, (sy - state.ty) / state.k];
  const toScreen = (x, y) => [x * state.k + state.tx, y * state.k + state.ty];

  // ---- render ----
  function visibleWorldRect() {
    const [x0, y0] = toWorld(0, 0);
    const [x1, y1] = toWorld(vw, vh);
    return { x0, y0, x1, y1 };
  }
  const inRect = (r, x, y, pad) => x >= r.x0 - pad && x <= r.x1 + pad && y >= r.y0 - pad && y <= r.y1 + pad;

  function render() {
    if (!state.dirty) return;
    state.dirty = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1a1b26";
    ctx.fillRect(0, 0, vw, vh);
    const rect = visibleWorldRect();
    const dimOthers = state.selected !== null;

    // file→file edges (always, subtle)
    ctx.lineWidth = 1;
    for (const e of model.fileEdges) {
      const s = fileById.get(e.source), t = fileById.get(e.target);
      if (!s || !t) continue;
      if (!inRect(rect, s.x, s.y, s.r) && !inRect(rect, t.x, t.y, t.r)) continue;
      const [sx, sy] = toScreen(s.x, s.y);
      const [tx2, ty2] = toScreen(t.x, t.y);
      ctx.strokeStyle = EDGE_COLORS[e.kind] ?? "#565f89";
      ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx2, ty2); ctx.stroke();
    }

    // symbol edges (both endpoint files expanded + kind enabled)
    for (const e of model.edges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const s = model.nodesById?.get(e.source) ?? null;
      if (!s) continue;
      const t = model.nodesById.get(e.target);
      if (!state.expanded.has(s.parent) || !state.expanded.has(t.parent)) continue;
      if (!inRect(rect, s.x, s.y, 20) && !inRect(rect, t.x, t.y, 20)) continue;
      const [sx, sy] = toScreen(s.x, s.y);
      const [tx2, ty2] = toScreen(t.x, t.y);
      const involved = state.selected === s.id || state.selected === t.id;
      const highlighted = state.highlight.has(s.id) || state.highlight.has(t.id);
      ctx.strokeStyle = involved || highlighted
        ? (state.selected === t.id ? CALLER_COLOR : CALLEE_COLOR)
        : (EDGE_COLORS[e.kind] ?? "#565f89");
      ctx.globalAlpha = dimOthers ? (involved || highlighted ? 0.9 : 0.06) : 0.35;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx2, ty2); ctx.stroke();
    }

    // files
    for (const f of files) {
      if (!inRect(rect, f.x, f.y, f.r * 1.2)) continue;
      const [sx, sy] = toScreen(f.x, f.y);
      const color = dirColor.get(f.dir.split("/")[0] || ".") ?? "#7aa2f7";
      if (state.expanded.has(f.id)) {
        ctx.globalAlpha = 0.8;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, f.r * state.k, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(f.name, sx, sy - f.r * state.k - 6);
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx, sy, pr, 0, Math.PI * 2); ctx.fill();
        if (state.k >= 0.6) {
          ctx.fillStyle = "#c0caf5";
          ctx.font = "11px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(f.name, sx, sy - pr - 5);
        }
      }
    }

    // symbols of expanded files
    for (const s of symbols) {
      if (!state.expanded.has(s.parent)) continue;
      if (!inRect(rect, s.x, s.y, 20)) continue;
      const [sx, sy] = toScreen(s.x, s.y);
      const isSel = state.selected === s.id;
      const isHl = state.highlight.has(s.id);
      ctx.globalAlpha = dimOthers ? (isSel || isHl ? 1 : 0.15) : 1;
      ctx.fillStyle = isHl ? (isCaller(s.id) ? CALLER_COLOR : CALLEE_COLOR) : (KIND_COLORS[s.kind] ?? "#c0caf5");
      ctx.beginPath(); ctx.arc(sx, sy, isSel ? 6 : 4, 0, Math.PI * 2); ctx.fill();
      if (isSel) {
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(sx, sy, 8, 0, Math.PI * 2); ctx.stroke();
      }
      if (state.k >= 2.5 || isSel) {
        ctx.fillStyle = "#c0caf5";
        ctx.font = "10px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(s.name, sx, sy - 8);
      }
    }
    ctx.globalAlpha = 1;
  }

  function isCaller(id) {
    return model.edges.some((e) => e.target === state.selected && e.source === id);
  }

  function frame() {
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // nodesById lookup attached once (used in edge drawing)
  model.nodesById = new Map(model.nodes.map((n) => [n.id, n]));

  // ---- interaction ----
  let dragStart = null, dragged = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    state.tx = dragStart.tx + dx; state.ty = dragStart.ty + dy;
    state.dirty = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (dragStart && !dragged) onClick(e.clientX, e.clientY);
    dragStart = null;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    state.k = Math.min(Math.max(state.k * factor, 0.05), 40);
    state.tx = e.clientX - wx * state.k;
    state.ty = e.clientY - wy * state.k;
    state.dirty = true;
  }, { passive: false });

  function onClick(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    const sym = nearestSymbol(wx, wy, Math.max(8 / state.k, 3));
    if (sym) { selectSymbol(sym); return; }
    // file ring (expanded) or file node (collapsed)?
    let hit = null;
    for (const f of files) {
      const d = Math.hypot(f.x - wx, f.y - wy);
      if (state.expanded.has(f.id)) {
        if (d <= f.r) { hit = f; break; }
      } else {
        const pr = (4 + 3 * Math.sqrt(Math.max(f.size, 1))) / state.k + 2;
        if (d <= pr) { hit = f; break; }
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

  function selectSymbol(sym) {
    state.selected = sym.id;
    state.highlight = new Set([sym.id]);
    for (const e of model.edges) {
      if (e.target === sym.id) state.highlight.add(e.source); // callers
      if (e.source === sym.id) state.highlight.add(e.target); // callees
    }
    showSidebar(sym);
    state.dirty = true;
  }

  function clearSelection() {
    state.selected = null;
    state.highlight = new Set();
    document.getElementById("sidebar").hidden = true;
    state.dirty = true;
  }

  function showSidebar(sym) {
    const el = document.getElementById("sidebar");
    el.hidden = false;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    el.innerHTML =
      `<h2>${esc(sym.name)}</h2>` +
      `<div class="kind">${esc(sym.kind)}</div>` +
      `<div class="loc">${esc(sym.file)}${sym.line != null ? ":" + sym.line : ""}</div>` +
      (sym.signature ? `<pre>${esc(sym.signature)}</pre>` : "") +
      (sym.docstring ? `<p>${esc(sym.docstring)}</p>` : "");
  }

  globalThis.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.selected) clearSelection();
      else if (state.expanded.size > 0) { state.expanded.clear(); rebuildPickIndex(); }
    }
  });

  // ---- search ----
  const search = document.getElementById("search");
  search.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    state.matches = q ? symbols.filter((s) => s.qualifiedName.toLowerCase().includes(q)) : [];
    state.matchIndex = 0;
  });
  search.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || state.matches.length === 0) return;
    const sym = state.matches[state.matchIndex % state.matches.length];
    state.matchIndex += 1;
    if (!state.expanded.has(sym.parent)) { state.expanded.add(sym.parent); rebuildPickIndex(); }
    zoomTo(sym);
    selectSymbol(sym);
  });

  function zoomTo(node) {
    state.k = 3;
    state.tx = vw / 2 - node.x * state.k;
    state.ty = vh / 2 - node.y * state.k;
    state.dirty = true;
  }

  // ---- toggles, legend, footer ----
  const toggles = document.getElementById("toggles");
  for (const kind of EDGE_KINDS) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = state.enabledEdges.has(kind);
    box.addEventListener("change", () => {
      if (box.checked) state.enabledEdges.add(kind);
      else state.enabledEdges.delete(kind);
      state.dirty = true;
    });
    label.append(box, document.createTextNode(kind));
    toggles.append(label);
  }

  const kindCounts = new Map();
  for (const s of symbols) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
  const legend = document.getElementById("legend");
  legend.innerHTML = [...kindCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) =>
      `<div class="row"><span><span class="sw" style="background:${KIND_COLORS[kind] ?? "#c0caf5"}"></span>${kind}</span><span>${count}</span></div>`)
    .join("");

  document.getElementById("footer").textContent =
    `${model.meta.project} — ${model.meta.nodeCount} nodes, ${model.meta.edgeCount} edges, ${model.meta.fileCount} files — generated ${model.meta.generatedAt}`;
}
```

- [ ] **Step 2: Syntax-gate the viewer**

Run: `node --check packages/codegraph-viz/viewer/viewer.js`
Expected: exit 0, no output

- [ ] **Step 3: Commit**

```bash
git add packages/codegraph-viz/viewer/viewer.js
git commit -m "feat(codegraph-viz): add canvas graph viewer"
```

---

### Task 6: viz.mjs — CLI entrypoint

**Files:**
- Create: `packages/codegraph-viz/viz.mjs`
- Create: `packages/codegraph-viz/README.md`
- Test: `packages/codegraph-viz/test/cli.test.mjs`

**Interfaces:**
- Consumes: `extractGraph` (Task 2), `computeLayout` (Task 3), `buildHtml` (Task 4), `viewer/viewer.js` (Task 5).
- Produces: CLI `codegraph-viz [path] [-o out.html] [--max-nodes N] [--force]`; exit 0 + prints output path on success; stderr + exit 1 on errors.

- [ ] **Step 1: Write the failing CLI tests**

`packages/codegraph-viz/test/cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureProject } from "./fixture.mjs";
import { extractPayload } from "../lib/emit.mjs";

const VIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "viz.mjs");

function run(args) {
  return spawnSync(process.execPath, [VIZ, ...args], { encoding: "utf8" });
}

test("generates a working html file from an index", () => {
  const { dir } = createFixtureProject();
  const out = join(mkdtempSync(join(tmpdir(), "cgv-out-")), "graph.html");
  const res = run([dir, "-o", out]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(out));
  const model = extractPayload(readFileSync(out, "utf8"));
  assert.equal(model.meta.nodeCount, 5);
  assert.ok(model.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y)));
});

test("missing index exits 1 with the spec message", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-noidx-"));
  const res = run([dir, "-o", join(dir, "x.html")]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no CodeGraph index at .+ — run `codegraph init -i` first/);
});

test("--max-nodes refuses unless --force is given", () => {
  const { dir } = createFixtureProject();
  const out = join(mkdtempSync(join(tmpdir(), "cgv-cap-")), "g.html");
  const refused = run([dir, "-o", out, "--max-nodes", "3"]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /5 nodes.*--force/s);
  const forced = run([dir, "-o", out, "--max-nodes", "3", "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: FAIL — spawn errors / `viz.mjs` missing (ENOENT)

- [ ] **Step 3: Implement viz.mjs**

`packages/codegraph-viz/viz.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractGraph } from "./lib/extract.mjs";
import { computeLayout } from "./lib/layout.mjs";
import { buildHtml } from "./lib/emit.mjs";

const DEFAULT_MAX_NODES = 100_000;

export function parseArgs(argv) {
  const opts = { path: ".", output: null, maxNodes: DEFAULT_MAX_NODES, force: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-o" || arg === "--output") opts.output = argv[++i] ?? null;
    else if (arg === "--max-nodes") opts.maxNodes = Number(argv[++i]);
    else if (arg === "--force") opts.force = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else positional.push(arg);
  }
  if (positional.length > 0) opts.path = positional[0];
  if (!Number.isFinite(opts.maxNodes) || opts.maxNodes < 1) {
    throw new Error(`--max-nodes must be a positive number`);
  }
  return opts;
}

const USAGE = `Usage: codegraph-viz [path] [-o out.html] [--max-nodes N] [--force]

Render a CodeGraph index (.codegraph/codegraph.db) as a self-contained
interactive HTML graph.

  path            project directory (default: current directory)
  -o, --output    output file (default: ./<dirname>-graph.html)
  --max-nodes N   refuse above N nodes without --force (default: ${DEFAULT_MAX_NODES})
  --force         override the node cap
  -h, --help      show this help
`;

export function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const projectPath = resolve(opts.path);
  const model = extractGraph(projectPath);
  if (model.meta.nodeCount > opts.maxNodes && !opts.force) {
    throw new Error(
      `${model.meta.nodeCount} nodes exceeds --max-nodes ${opts.maxNodes} — rerun with --force to render anyway`,
    );
  }
  computeLayout(model);
  const viewerJs = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "viewer", "viewer.js"),
    "utf8",
  );
  const html = buildHtml(model, viewerJs);
  const output = resolve(opts.output ?? `./${basename(projectPath)}-graph.html`);
  writeFileSync(output, html);
  process.stdout.write(`${output}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`codegraph-viz: ${err.message}\n`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/codegraph-viz && node --test test/`
Expected: PASS, 16 tests

- [ ] **Step 5: Write README.md**

`packages/codegraph-viz/README.md`:

```markdown
# codegraph-viz

Render a [CodeGraph](https://github.com/colbymchenry/codegraph) index as a
single self-contained interactive HTML file — no server, no CDN, no
telemetry.

```sh
codegraph-viz [path] [-o out.html] [--max-nodes N] [--force]
```

Requires a project already indexed with `codegraph init -i`. Opens at the
file level; click a file to expand its symbols, click a symbol for its
details and caller/callee highlights, search with the box top-left, toggle
edge kinds in the HUD. ESC clears selection, then collapses all files.

Zero runtime dependencies (Node 24+ stdlib only). Layout is precomputed and
deterministic; the browser only renders.
```

- [ ] **Step 6: Commit**

```bash
git add packages/codegraph-viz/viz.mjs packages/codegraph-viz/README.md packages/codegraph-viz/test/cli.test.mjs
git commit -m "feat(codegraph-viz): add CLI entrypoint"
```

---

### Task 7: Nix packaging + flake/devshell/home wiring

**Files:**
- Create: `nix/packages/codegraph-viz.nix`
- Create: `modules/packages/codegraph-viz.nix`
- Modify: `modules/devshells/default.nix`
- Modify: `modules/home/pi.nix`

**Interfaces:**
- Consumes: the whole `packages/codegraph-viz/` tree (Tasks 1–6).
- Produces: flake package `.#codegraph-viz`, flake check `.#checks.x86_64-linux.codegraph-viz-tests`, CLI on PATH in both devshells and Home Manager (`installCodegraphViz`, default true).

- [ ] **Step 1: Write the Nix package**

`nix/packages/codegraph-viz.nix`:

```nix
{ pkgs }:
pkgs.runCommand "codegraph-viz-0.1.0" { } ''
  mkdir -p $out/libexec/codegraph-viz $out/bin
  cp -r ${../../packages/codegraph-viz}/. $out/libexec/codegraph-viz/
  cat > $out/bin/codegraph-viz <<EOF
  #!${pkgs.runtimeShell}
  exec ${pkgs.nodejs_24}/bin/node $out/libexec/codegraph-viz/viz.mjs "\$@"
  EOF
  chmod +x $out/bin/codegraph-viz
''
```

- [ ] **Step 2: Write the flake module (package + test check)**

`modules/packages/codegraph-viz.nix`:

```nix
{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      package = import ../../nix/packages/codegraph-viz.nix { inherit pkgs; };
    in
    {
      packages."codegraph-viz" = package;

      checks."codegraph-viz-tests" = pkgs.runCommand "codegraph-viz-tests" { } ''
        cp -r ${../../packages/codegraph-viz} src
        chmod -R u+w src
        cd src
        ${pkgs.nodejs_24}/bin/node --test test/
        touch $out
      '';
    };
}
```

- [ ] **Step 3: Wire devshells**

In `modules/devshells/default.nix`, add `self'.packages.codegraph-viz`:

- to `devShells.default` `packages`, right after `self'.packages.codegraph`
- to the jailed devshell's `extraPkgs`, right after `self'.packages.codegraph`

- [ ] **Step 4: Wire Home Manager**

In `modules/home/pi.nix`:

- Add option next to `installCodegraphCli`:

```nix
        installCodegraphViz = mkOption {
          type = types.bool;
          default = true;
          description = "Whether to install the codegraph-viz graph HTML renderer.";
        };
```

- Extend `home.packages`:

```nix
        ++ optional cfg.installCodegraphCli self.packages.${pkgs.system}.codegraph
        ++ optional cfg.installCodegraphViz self.packages.${pkgs.system}.codegraph-viz;
```

- [ ] **Step 5: Stage, format, build, and run the test check**

```bash
git add -A
nixfmt nix/packages/codegraph-viz.nix modules/packages/codegraph-viz.nix modules/devshells/default.nix modules/home/pi.nix
nix build .#codegraph-viz --no-link --print-out-paths
nix build .#checks.x86_64-linux.codegraph-viz-tests --no-link --print-build-logs
```

Expected: both succeed; the check log shows `pass 16`.

- [ ] **Step 6: Smoke the wrapped CLI on a real index**

Use the existing real index at `/tmp/cg-roche` (roche-pi copy, 4,361 nodes — recreate with `git archive HEAD | tar -x -C /tmp/cg-roche && cd /tmp/cg-roche && codegraph init -i` if missing):

```bash
CGV=$(nix build .#codegraph-viz --no-link --print-out-paths)
$CGV/bin/codegraph-viz /tmp/cg-roche -o /tmp/cg-roche-graph.html
ls -la /tmp/cg-roche-graph.html
```

Expected: exit 0, prints `/tmp/cg-roche-graph.html`; file exists (expect roughly 1–4 MB).

- [ ] **Step 7: Commit**

```bash
git add nix/packages/codegraph-viz.nix modules/packages/codegraph-viz.nix modules/devshells/default.nix modules/home/pi.nix
git commit -m "feat(codegraph-viz): package via flake with devshell and home wiring"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Repo-mandated checks**

Per AGENTS.md (packaged Pi dependency tooling changed):

```bash
nix build .#checks.x86_64-linux.pi-config-extension-load --no-link
nix flake check --accept-flake-config --print-build-logs 2>&1 | tail -5
```

Expected: `all checks passed!`

- [ ] **Step 2: Confirm node cap guard on a big repo (optional, if a >100k-node index is available — otherwise skip)**

Skip unless such an index exists; the guard is covered by `cli.test.mjs`.

- [ ] **Step 3: Report for manual browser smoke**

Hand the user `/tmp/cg-roche-graph.html` to open: verify expand/collapse,
symbol sidebar, search, edge toggles, ESC. This is the manual half of the
Testing Value Gate for the viewer.

- [ ] **Step 4: Finish**

Present branch-completion options per `finishing-a-development-branch`
(squash merge into `main` locally is the repo-preferred option).

---

## Self-Review Notes (filled by the plan author)

- **Spec coverage:** CLI flags → Task 6; extract/hierarchy/aggregation → Task 2; two-phase deterministic layout → Task 3; gzip+base64 single-file HTML → Task 4; viewer features (canvas, culling, LOD labels, expand/collapse, sidebar, highlight, search, toggles, legend, footer, ESC) → Task 5; Nix package/devshell/home/check → Task 7; error table → Tasks 2 and 6; verification commands → Task 8. No gaps.
- **Type consistency:** `extractGraph(projectPath) → model`; `computeLayout(model) → model` (mutating); `buildHtml(model, viewerJs) → string`; `extractPayload(html) → model`; `createFixtureProject() → { dir }`; `parseArgs(argv) → opts`; `main(argv) → number`. Payload fields match the Global Constraints contract (`qualifiedName`, `parent`, `size`, `x`, `y`, `r`, `fileEdges[].weight`).
