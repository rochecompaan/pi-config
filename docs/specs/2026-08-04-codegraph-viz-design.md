# codegraph-viz — Design

Date: 2026-08-04
Status: Approved design, pre-plan

## Context

roche-pi now packages `@colbymchenry/codegraph` (CLI) and `@vndv/pi-codegraph`
(pi extension). CodeGraph builds a per-project SQLite knowledge graph at
`.codegraph/codegraph.db` (tables `nodes`, `edges`, `files`, FTS auxiliaries),
but has no visualization. We want a self-contained, single-file interactive
HTML rendering of a whole codebase graph that stays fluid at real-world scale.

Measured reference point: roche-pi itself indexes to 4,361 nodes / 10,979
edges (199 files, ~1.7k functions+methods) — a typical repo lands in the
5k–50k node range.

## Goals

- One command produces one `.html` file: no server, no CDN, no network at view
  time, no telemetry.
- Fluid interaction at 50k indexed nodes on a typical laptop browser.
- Clickable nodes: inspect a symbol, see its callers/callees, expand files
  into their symbols on demand (lazy rendering, not lazy data).
- Zero runtime dependencies for the generator: Node standard library only.

## Non-goals (YAGNI)

- No in-browser force simulation (positions are precomputed).
- No source-code embedding in the payload.
- No WebGL/sigma.js renderer; no inlined d3 bundle; no npm dependencies.
- No pi extension wrapper (may follow later once the CLI proves useful).
- No editing, diffing, or git-history features.

## Invocation and packaging

- CLI: `codegraph-viz [path] [-o out.html] [--max-nodes N] [--force]`
  - `path` defaults to the current working directory.
  - Output defaults to `./<basename(path)>-graph.html`.
  - Refuses to run when the extracted node count exceeds `--max-nodes`
    (default 100,000) unless `--force` is given.
  - Exit code 0 on success, 1 with a message on stderr otherwise.
- Lives in `packages/codegraph-viz/` in this repo (mirrors
  `packages/jailed-github-broker`).
- Nix:
  - `nix/packages/codegraph-viz.nix`: `runCommand` that installs the package
    tree and writes a wrapper `$out/bin/codegraph-viz` executing
    `${pkgs.nodejs_24}/bin/node $out/libexec/codegraph-viz/viz.mjs`.
    Node 24 is required because `node:sqlite` is available unflagged there.
  - Exposed as flake package `.#codegraph-viz` in `modules/packages/`.
  - Added to the default and jailed devshells in `modules/devshells/default.nix`.
  - Home Manager: new `installCodegraphViz` option (default `true`) in
    `modules/home/pi.nix`, mirroring `installCodegraphCli`.
  - Flake check `codegraph-viz-tests` runs `node --test` over the package
    test suite.

## Components

```
packages/codegraph-viz/
├── viz.mjs            CLI entry: arg parsing, orchestration, errors
├── lib/
│   ├── extract.mjs    read-only SQLite → graph model + hierarchy
│   ├── layout.mjs     deterministic seeded two-phase force layout
│   └── emit.mjs       payload gzip+base64 → single-file HTML
├── viewer/
│   └── viewer.js      hand-rolled canvas viewer, embedded verbatim
└── test/
    ├── extract.test.mjs
    ├── layout.test.mjs
    └── emit.test.mjs
```

### extract.mjs

- Opens `.codegraph/codegraph.db` under the given path with
  `node:sqlite` `DatabaseSync` in read-only mode (a live codegraph daemon
  holding the DB in WAL mode must not block extraction).
- Reads `nodes` (id, kind, name, qualified_name, file_path, start_line,
  signature, docstring, language) and `edges` (source, target, kind).
- Edge kinds kept: `calls`, `references`, `imports`, `instantiates`,
  `implements`. `contains` is used only for hierarchy, never rendered.
- Builds the hierarchy directory → file → symbol:
  - Symbol parent = its `file_path` entry; file parent = its directory,
    derived from path prefixes (not from `contains`, which only links
    file → symbol).
- Aggregates symbol-level edges into weighted file→file edges for the
  top-level view (weight = count of underlying symbol edges).
- Trims `docstring` to 500 chars and drops null/empty fields to keep the
  payload small.
- Returns `{ meta, nodes, edges, files }` where `meta` carries project name
  (basename of path), counts, and generation timestamp.

### layout.mjs

Deterministic: seeded PRNG (mulberry32, fixed seed), fixed tick budget,
no time- or randomness-dependent behavior — same input DB → same positions.

Two phases:

1. **File phase** — force layout over file nodes using aggregated weighted
   file→file edges: Barnes–Hut quadtree repulsion (theta 0.8), spring forces
   along edges (strength ∝ edge weight), mild centering gravity. ~400 ticks.
2. **Symbol phase** — per file, a local force layout of that file's symbols:
   repulsion + springs along intra-file `calls` edges + radial gravity toward
   the file center. Symbol coordinates are offsets within the file's frame;
   a file's symbols occupy a disc whose radius scales with `sqrt(count)`.

Viewer computes absolute positions as `fileCenter + localOffset`; files
therefore never overlap their own symbols, and expanded files do not disturb
the global arrangement.

### emit.mjs

- Serializes the model to JSON, compresses with gzip, base64-encodes.
- Emits one HTML file: minimal markup, an inline `<script>` containing
  `viewer/viewer.js` verbatim, and the payload in a
  `<script type="application/octet-stream">` block as base64 text.
- The viewer inflates via the browser-native `DecompressionStream("gzip")`
  — no shipped compression library.
- Rough size budget: ~1.5 MB for a 5k-node repo, ~15 MB for 50k nodes.

### viewer.js

Hand-rolled vanilla JS (no imports). Runs entirely from the single file.

- **Rendering**: 2D canvas. File-level nodes are colored by top-level
  directory, symbol-level nodes by kind; labels only beyond a zoom threshold
  and only for visible nodes; edges as lines with alpha scaled to zoom.
  Everything culled to the viewport.
- **Initial view**: file-level graph. Node radius ∝ sqrt(symbol count),
  color by top-level directory.
- **Pan/zoom**: pointer drag + wheel zoom around cursor (own transform math).
- **Picking**: quadtree over currently rendered nodes, rebuilt on view change;
  click hit-tests nearest node within a pixel tolerance.
- **Expand/collapse**: clicking a file node expands it — the file becomes a
  ring enclosing its symbols, which fade in (positions from layout phase 2)
  with their intra-visible edges; clicking the ring again or pressing ESC
  collapses it. Cross-file symbol edges render only while both endpoint
  files are expanded.
- **Symbol inspection**: clicking a symbol opens a sidebar (name, kind,
  signature, docstring, `file:line`) and highlights direct callers
  (one hue) and callees (another); all other nodes dim.
- **Search**: substring match over `qualified_name`; Enter zooms to the
  first match and cycles through further matches.
- **Edge toggles**: `calls` on by default; `imports`, `references`,
  `instantiates`, `implements` off by default; toggles re-filter rendered
  edges without touching data.
- **Chrome**: legend (kind colors + counts), footer (project name, node/edge
  counts, generation timestamp).

## Error handling

| Condition | Behavior |
|---|---|
| `.codegraph/codegraph.db` missing | stderr: "no CodeGraph index at <path> — run `codegraph init -i` first", exit 1 |
| DB open/read failure | stderr with the SQLite error, exit 1 |
| Index has 0 nodes | stderr: "index at <path> is empty", exit 1 |
| Node count > `--max-nodes` without `--force` | stderr with count and hint, exit 1 |
| Output path not writable | stderr with the fs error, exit 1 |
| Corrupt/unexpected schema (missing `nodes`/`edges` tables) | stderr naming the missing table, exit 1 |

## Testing

Automated (`node:test`, zero deps, run in the package and as a flake check):

- `extract`: fixture DB built in-test with `node:sqlite` (nodes/edges/files
  rows covering hierarchy, all kept edge kinds, docstring trimming);
  hierarchy correctness (dir→file→symbol parents); file→file aggregation
  weights; error cases (missing DB, missing tables, empty index).
- `layout`: determinism (same fixture → identical coordinates across two
  runs); containment (symbols stay within their file disc radius);
  no NaN positions; single-node and single-file edge cases.
- `emit`: gzip→base64→inflate→JSON round-trip equals the input model;
  emitted HTML contains the viewer script and exactly one payload block.
- Viewer: `node --check viewer/viewer.js` syntax gate (browser behavior
  verified by manual smoke per the Testing Value Gate — no browser
  automation harness).

## Verification

- `nix build .#codegraph-viz` produces a working wrapper.
- Generate `roche-pi`'s own graph (reference: 4,361 nodes) and open the HTML
  manually: expand a file, inspect a symbol, search, toggle edge kinds.
- `nix build .#checks.x86_64-linux.pi-config-extension-load --no-link`
  (config still loads) and full `nix flake check --accept-flake-config
  --print-build-logs`.

## Risks

- **`node:sqlite` availability**: requires Node ≥ 23 unflagged; mitigated by
  pinning `nodejs_24` in the wrapper (same major the vendored codegraph
  runtime uses).
- **Schema drift in codegraph**: extraction targets the current
  nodes/edges schema; the corrupt-schema error path fails loudly rather
  than silently misrendering. Version coupling is acceptable because both
  packages are pinned in the same repo.
- **Hand-rolled layout quality**: sufficient for cluster readability at our
  scale; if it proves poor, swap `layout.mjs` internals only — the payload
  contract is unchanged.
