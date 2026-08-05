import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureProject } from "./fixture.mjs";
import { extractGraph } from "../lib/extract.mjs";
import { computeLayout, indexLocalCallLinks } from "../lib/layout.mjs";

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

test("local call links preserve input order and exclude file endpoints and cross-file calls", () => {
  const nodes = [
    { id: "file:a", kind: "file", parent: null },
    { id: "file:b", kind: "file", parent: null },
    { id: "a:one", kind: "function", parent: "file:a" },
    { id: "a:two", kind: "function", parent: "file:a" },
    { id: "b:one", kind: "function", parent: "file:b" },
  ];
  const edges = [
    { source: "a:two", target: "a:one", kind: "calls" },
    { source: "a:one", target: "b:one", kind: "calls" },
    { source: "file:a", target: "a:one", kind: "calls" },
    { source: "a:one", target: "a:two", kind: "references" },
    { source: "a:one", target: "a:two", kind: "calls" },
  ];

  assert.deepEqual(indexLocalCallLinks(nodes, edges), new Map([
    ["file:a", [
      { source: "a:two", target: "a:one", weight: 1 },
      { source: "a:one", target: "a:two", weight: 1 },
    ]],
  ]));
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
