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
  const rows = [...nodeRows];
  const fileIdByPath = new Map();
  for (const row of rows) {
    if (row.kind === "file") fileIdByPath.set(row.file_path, row.id);
  }

  const nodes = [];
  const symbolCountByFile = new Map();

  // Symbols first. A symbol whose file_path has no file node gets a
  // synthesized file node appended to the working copy; the file pass below
  // visits it because arrays iterate appended elements.
  for (const row of rows) {
    if (row.kind === "file") continue;
    let fileId = fileIdByPath.get(row.file_path);
    if (!fileId) {
      fileId = `file:${row.file_path}`;
      fileIdByPath.set(row.file_path, fileId);
      rows.push({
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

  for (const row of rows) {
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
    if (!source || !target) continue;
    edges.push({ source: row.source, target: row.target, kind: row.kind });
    const sf = source.kind === "file" ? source.id : source.parent;
    const tf = target.kind === "file" ? target.id : target.parent;
    if (sf !== tf) {
      const key = JSON.stringify([sf, tf, row.kind]);
      fileEdgeWeights.set(key, (fileEdgeWeights.get(key) ?? 0) + 1);
    }
  }
  const fileEdges = [...fileEdgeWeights].map(([key, weight]) => {
    const [source, target, kind] = JSON.parse(key);
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
