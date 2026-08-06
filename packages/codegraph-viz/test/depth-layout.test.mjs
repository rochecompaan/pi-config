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
