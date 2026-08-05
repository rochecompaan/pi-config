import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createFixtureProject } from "./fixture.mjs";
import { extractPayload } from "../lib/emit.mjs";

const VIZ = join(dirname(fileURLToPath(import.meta.url)), "..", "viz.mjs");

function run(args) {
  return spawnSync(process.execPath, [VIZ, ...args], { encoding: "utf8" });
}

test("prints help when invoked through a symlink", () => {
  const link = join(mkdtempSync(join(tmpdir(), "cgv-link-")), "viz.mjs");
  symlinkSync(VIZ, link);
  const res = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^Usage: codegraph-viz \[path\]/m);
});

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
