import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFixtureProject } from "./fixture.mjs";
import { buildModel, extractGraph } from "../lib/extract.mjs";

test("fixture builds a codegraph-shaped DB", () => {
  const { dir } = createFixtureProject();
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"), { readOnly: true });

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nodes").get().c, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'file'").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'function'").get().c, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE kind = 'class'").get().c, 1);

  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM edges").get().c, 6);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'contains'").get().c, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'calls'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'instantiates'").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM edges WHERE kind = 'references'").get().c, 1);

  const nonContainsEdges = db
    .prepare("SELECT source, target, kind FROM edges WHERE kind != 'contains' ORDER BY source, target, kind")
    .all()
    .map(({ source, target, kind }) => `${source}|${target}|${kind}`)
    .sort();
  assert.deepStrictEqual(nonContainsEdges, [
    "cls:Greeter|fn:greet|references",
    "fn:main|cls:Greeter|instantiates",
    "fn:main|fn:greet|calls",
  ].sort());

  db.close();
});

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

test("buildModel does not mutate its input rows when synthesizing files", () => {
  const nodeRows = [{
    id: "fn:orphan", kind: "function", name: "orphan", qualified_name: "orphan",
    file_path: "src/orphan.ts", start_line: 1, signature: null, docstring: null,
  }];

  buildModel("/tmp/project", nodeRows, []);

  assert.equal(nodeRows.length, 1);
});

test("buildModel synthesizes file hierarchy and filters edge kinds", () => {
  const filePath = "src/generated/orphan file.ts";
  const fileId = `file:${filePath}`;
  const edgeCases = [
    ...["calls", "references", "imports", "instantiates", "implements"].map((kind) => ({
      source: "fn:alpha", target: "fn:beta", kind, include: true,
    })),
    { source: "fn:alpha", target: "fn:beta", kind: "contains", include: false },
    { source: "fn:alpha", target: "fn:beta", kind: "decorates", include: false },
    { source: "fn:unknown", target: "fn:beta", kind: "calls", include: false },
  ];
  const model = buildModel("/tmp/project", [
    { id: "fn:alpha", kind: "function", name: "alpha", qualified_name: "alpha", file_path: filePath, start_line: 1 },
    { id: "fn:beta", kind: "function", name: "beta", qualified_name: "beta", file_path: filePath, start_line: 2 },
  ], edgeCases);

  const alpha = model.nodes.find((node) => node.id === "fn:alpha");
  assert.deepEqual(
    { parent: alpha.parent, file: alpha.file, dir: alpha.dir },
    { parent: fileId, file: filePath, dir: "src/generated" },
  );
  const file = model.nodes.find((node) => node.id === fileId);
  assert.deepEqual(
    { kind: file.kind, parent: file.parent, file: file.file, dir: file.dir, size: file.size },
    { kind: "file", parent: null, file: filePath, dir: "src/generated", size: 2 },
  );
  assert.deepEqual(
    model.edges,
    edgeCases
      .filter((edge) => edge.include)
      .map(({ source, target, kind }) => ({ source, target, kind })),
  );
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

test("fileEdges preserve file IDs containing spaces", () => {
  const sourceFile = "file:src/from space.ts";
  const targetFile = "file:src/to space.ts";
  const model = buildModel("/tmp/project", [
    { id: sourceFile, kind: "file", name: "from space.ts", qualified_name: "src/from space.ts", file_path: "src/from space.ts" },
    { id: targetFile, kind: "file", name: "to space.ts", qualified_name: "src/to space.ts", file_path: "src/to space.ts" },
    { id: "fn:from", kind: "function", name: "from", qualified_name: "from", file_path: "src/from space.ts", start_line: 1 },
    { id: "fn:to", kind: "function", name: "to", qualified_name: "to", file_path: "src/to space.ts", start_line: 1 },
  ], [
    { source: "fn:from", target: "fn:to", kind: "calls" },
    { source: "fn:from", target: "fn:to", kind: "calls" },
  ]);

  assert.deepEqual(model.fileEdges, [{ source: sourceFile, target: targetFile, kind: "calls", weight: 2 }]);
});

test("missing index → spec-verbatim error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-empty-"));
  assert.throws(() => extractGraph(dir), /no CodeGraph index at .+ — run `codegraph init -i` first/);
});

test("missing tables → names the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-notables-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"));
  db.exec("CREATE TABLE nodes (id TEXT)");
  db.close();
  assert.throws(() => extractGraph(dir), /missing table 'edges'/);
});

test("empty index → spec-verbatim error", () => {
  const dir = mkdtempSync(join(tmpdir(), "cgv-norows-"));
  mkdirSync(join(dir, ".codegraph"));
  const db = new DatabaseSync(join(dir, ".codegraph", "codegraph.db"));
  db.exec(`
    CREATE TABLE nodes (
      id TEXT, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT,
      start_line INTEGER, signature TEXT, docstring TEXT
    );
    CREATE TABLE edges (source TEXT, target TEXT, kind TEXT);
  `);
  db.close();
  assert.throws(() => extractGraph(dir), /is empty/);
});
