import { test } from "node:test";
import assert from "node:assert/strict";
import { createFixtureProject } from "./fixture.mjs";
import { extractGraph } from "../lib/extract.mjs";
import { computeLayout } from "../lib/layout.mjs";
import { buildHtml, extractPayload, inlineViewerSources } from "../lib/emit.mjs";

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

test("extractPayload rejects HTML without a payload block", () => {
  assert.throws(() => extractPayload("<!doctype html>"), /payload/i);
});

test("inlineViewerSources strips the export line and keeps source order", () => {
  const projection = "function rotate() {}\nfunction project() {}\nexport { rotate, project };\n";
  const out = inlineViewerSources(projection, "/* viewer */");
  assert.ok(!out.includes("export {"));
  assert.ok(out.indexOf("function project()") < out.indexOf("/* viewer */"));
});

test("inlineViewerSources rejects a projection source without an export line", () => {
  assert.throws(() => inlineViewerSources("function project() {}\n", ""), /export/);
});
