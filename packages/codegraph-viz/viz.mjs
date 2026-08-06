import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractGraph } from "./lib/extract.mjs";
import { computeLayout } from "./lib/layout.mjs";
import { buildHtml, inlineViewerSources } from "./lib/emit.mjs";

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
    throw new Error("--max-nodes must be a positive number");
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
  const projectionJs = readFileSync(
    join(import.meta.dirname, "lib", "projection.mjs"),
    "utf8",
  );
  const viewerJs = readFileSync(
    join(import.meta.dirname, "viewer", "viewer.js"),
    "utf8",
  );
  const html = buildHtml(model, inlineViewerSources(projectionJs, viewerJs));
  const output = resolve(opts.output ?? `./${basename(projectPath)}-graph.html`);
  writeFileSync(output, html);
  process.stdout.write(`${output}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`codegraph-viz: ${err.message}\n`);
    process.exitCode = 1;
  }
}
