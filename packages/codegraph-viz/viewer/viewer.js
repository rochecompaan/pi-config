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
  const nodeById = new Map(model.nodes.map((n) => [n.id, n]));
  const incomingCalls = new Map();
  const outgoingCalls = new Map();
  for (const edge of model.edges) {
    if (edge.kind !== "calls") continue;
    if (!incomingCalls.has(edge.target)) incomingCalls.set(edge.target, new Set());
    if (!outgoingCalls.has(edge.source)) outgoingCalls.set(edge.source, new Set());
    incomingCalls.get(edge.target).add(edge.source);
    outgoingCalls.get(edge.source).add(edge.target);
  }

  const KIND_COLORS = new Map([
    ["function", "#7aa2f7"], ["method", "#7aa2f7"], ["class", "#e0af68"],
    ["struct", "#e0af68"], ["interface", "#9ece6a"], ["type_alias", "#9ece6a"],
    ["variable", "#bb9af7"], ["constant", "#bb9af7"], ["property", "#73daca"],
    ["import", "#565f89"],
  ]);
  const EDGE_COLORS = new Map([
    ["calls", "#7aa2f7"], ["references", "#9ece6a"], ["imports", "#565f89"],
    ["instantiates", "#e0af68"], ["implements", "#f7768e"],
  ]);
  const EDGE_KINDS = [...EDGE_COLORS.keys()];
  const CALLER_COLOR = "#f7768e";
  const CALLEE_COLOR = "#9ece6a";

  const dirs = [...new Set(files.map((f) => f.dir.split("/")[0] || "."))].sort();
  const dirColor = new Map(dirs.map((d, i) => [d, `hsl(${Math.round((i * 137.5) % 360)},55%,55%)`]));

  const state = {
    expanded: new Set(),
    selected: null,
    highlight: new Set(),
    callers: new Set(),
    callees: new Set(),
    selectedFile: null,
    relatedFiles: new Set(),
    callerFiles: new Set(),
    calleeFiles: new Set(),
    directFileEdges: new Set(),
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
    vw = globalThis.innerWidth;
    vh = globalThis.innerHeight;
    canvas.width = vw * dpr;
    canvas.height = vh * dpr;
    canvas.style.width = vw + "px";
    canvas.style.height = vh + "px";
    state.dirty = true;
  }
  globalThis.addEventListener("resize", resize);
  resize();

  function fitToContent() {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of files) {
      minX = Math.min(minX, f.x - f.r);
      maxX = Math.max(maxX, f.x + f.r);
      minY = Math.min(minY, f.y - f.r);
      maxY = Math.max(maxY, f.y + f.r);
    }
    const w = Math.max(maxX - minX, 1);
    const h = Math.max(maxY - minY, 1);
    state.k = Math.min(vw / w, vh / h) * 0.9;
    state.tx = vw / 2 - ((minX + maxX) / 2) * state.k;
    state.ty = vh / 2 - ((minY + maxY) / 2) * state.k;
  }
  fitToContent();

  // ---- pick index (point quadtree over symbols of expanded files) ----
  const MAX_QUAD_DEPTH = 32;
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
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
    const root = { x: minX, y: minY, size: Math.max(maxX - minX, maxY - minY, 1), points: [], children: null };
    for (const p of pts) insertPt(root, p, 0);
    return root;
  }
  function insertPt(node, p, depth) {
    if (node.children) {
      insertPt(childFor(node, p), p, depth + 1);
      return;
    }
    if (node.points.length === 0) {
      node.points.push(p);
      return;
    }
    if (node.points.every((point) => point.x === p.x && point.y === p.y) || depth >= MAX_QUAD_DEPTH) {
      node.points.push(p);
      return;
    }
    const h = node.size / 2;
    node.children = [
      { x: node.x, y: node.y, size: h, points: [], children: null },
      { x: node.x + h, y: node.y, size: h, points: [], children: null },
      { x: node.x, y: node.y + h, size: h, points: [], children: null },
      { x: node.x + h, y: node.y + h, size: h, points: [], children: null },
    ];
    const existing = node.points;
    node.points = [];
    for (const point of existing) insertPt(childFor(node, point), point, depth + 1);
    insertPt(childFor(node, p), p, depth + 1);
  }
  function childFor(node, p) {
    const right = p.x >= node.x + node.size / 2 ? 1 : 0;
    const bottom = p.y >= node.y + node.size / 2 ? 2 : 0;
    return node.children[right + bottom];
  }
  function nearestSymbol(x, y, maxDist) {
    let best = null, bestD = maxDist;
    (function visit(node) {
      if (!node) return;
      if (x < node.x - bestD || x > node.x + node.size + bestD) return;
      if (y < node.y - bestD || y > node.y + node.size + bestD) return;
      if (!node.children) {
        for (const point of node.points) {
          const d = Math.hypot(point.x - x, point.y - y);
          if (d < bestD) {
            best = point;
            bestD = d;
          }
        }
      }
      if (node.children) for (const child of node.children) visit(child);
    })(symbolTree);
    return best;
  }

  // ---- transform helpers ----
  const toWorld = (sx, sy) => [(sx - state.tx) / state.k, (sy - state.ty) / state.k];
  const toScreen = (x, y) => [x * state.k + state.tx, y * state.k + state.ty];
  const owningFile = (node) => node.kind === "file" ? node.id : node.parent;
  const fileEdgeKey = (source, target, kind) => JSON.stringify([source, target, kind]);

  // ---- render ----
  function visibleWorldRect() {
    const [x0, y0] = toWorld(0, 0);
    const [x1, y1] = toWorld(vw, vh);
    return { x0, y0, x1, y1 };
  }
  const inRect = (rect, x, y, pad) => x >= rect.x0 - pad && x <= rect.x1 + pad && y >= rect.y0 - pad && y <= rect.y1 + pad;

  function render() {
    if (!state.dirty) return;
    state.dirty = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#1a1b26";
    ctx.fillRect(0, 0, vw, vh);
    const rect = visibleWorldRect();
    const dimOthers = state.selected !== null;

    // Aggregated file context follows the same kind toggles as detail edges.
    ctx.lineWidth = 1;
    for (const e of model.fileEdges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = fileById.get(e.source);
      const target = fileById.get(e.target);
      if (!source || !target) continue;
      if (!inRect(rect, source.x, source.y, source.r) && !inRect(rect, target.x, target.y, target.r)) continue;
      const [sx, sy] = toScreen(source.x, source.y);
      const [tx, ty] = toScreen(target.x, target.y);
      const directContext = state.directFileEdges.has(fileEdgeKey(e.source, e.target, e.kind));
      ctx.strokeStyle = EDGE_COLORS.get(e.kind) ?? "#565f89";
      ctx.globalAlpha = dimOthers ? (directContext ? 0.75 : 0.025) : 0.15;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // Detail edges require both owning files expanded; file↔file stays aggregated.
    for (const e of model.edges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = nodeById.get(e.source);
      const target = nodeById.get(e.target);
      if (!source || !target || (source.kind === "file" && target.kind === "file")) continue;
      if (!state.expanded.has(owningFile(source)) || !state.expanded.has(owningFile(target))) continue;
      if (!inRect(rect, source.x, source.y, 20) && !inRect(rect, target.x, target.y, 20)) continue;
      const [sx, sy] = toScreen(source.x, source.y);
      const [tx, ty] = toScreen(target.x, target.y);
      const selectedCall = e.kind === "calls" && (state.selected === source.id || state.selected === target.id);
      ctx.strokeStyle = selectedCall
        ? (state.selected === target.id ? CALLER_COLOR : CALLEE_COLOR)
        : (EDGE_COLORS.get(e.kind) ?? "#565f89");
      ctx.globalAlpha = dimOthers ? (selectedCall ? 0.9 : 0.06) : 0.35;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // Files participate in direct-call focus even when the endpoint is a symbol.
    for (const f of files) {
      if (!inRect(rect, f.x, f.y, f.r * 1.2)) continue;
      const [sx, sy] = toScreen(f.x, f.y);
      const baseColor = dirColor.get(f.dir.split("/")[0] || ".") ?? "#7aa2f7";
      const color = f.id === state.selectedFile ? "#ffffff"
        : state.callerFiles.has(f.id) ? CALLER_COLOR
          : state.calleeFiles.has(f.id) ? CALLEE_COLOR : baseColor;
      const related = state.relatedFiles.has(f.id);
      ctx.globalAlpha = dimOthers ? (related ? 0.95 : 0.12) : 1;
      if (state.expanded.has(f.id)) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(sx, sy, f.r * state.k, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.font = "12px system-ui";
        ctx.textAlign = "center";
        ctx.fillText(f.name, sx, sy - f.r * state.k - 6);
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, pr, 0, Math.PI * 2);
        ctx.fill();
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
      const isSelected = state.selected === s.id;
      const isHighlighted = state.highlight.has(s.id);
      ctx.globalAlpha = dimOthers ? (isSelected || isHighlighted ? 1 : 0.15) : 1;
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
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- interaction ----
  let dragStart = null, dragged = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragStart = { x: e.clientX, y: e.clientY, tx: state.tx, ty: state.ty };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    state.tx = dragStart.tx + dx;
    state.ty = dragStart.ty + dy;
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
    const sym = nearestSymbol(wx, wy, 8 / state.k);
    if (sym) {
      selectSymbol(sym);
      return;
    }
    let hit = null;
    for (const f of files) {
      const distance = Math.hypot(f.x - wx, f.y - wy);
      if (state.expanded.has(f.id)) {
        const ringTolerancePx = 8;
        if (Math.abs(distance - f.r) <= ringTolerancePx / state.k) {
          hit = f;
          break;
        }
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        if (distance <= (pr + 2) / state.k) {
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

  function selectSymbol(sym) {
    state.selected = sym.id;
    state.callers = new Set(incomingCalls.get(sym.id));
    state.callees = new Set(outgoingCalls.get(sym.id));
    state.highlight = new Set([sym.id, ...state.callers, ...state.callees]);
    state.selectedFile = owningFile(sym);
    state.relatedFiles = new Set([state.selectedFile]);
    state.callerFiles = new Set();
    state.calleeFiles = new Set();
    state.directFileEdges = new Set();
    addFileContext(state.callers, state.callerFiles, true);
    addFileContext(state.callees, state.calleeFiles, false);
    showSidebar(sym);
    state.dirty = true;
  }

  function addFileContext(nodeIds, relationFiles, incoming) {
    for (const id of nodeIds) {
      const node = nodeById.get(id);
      if (!node) continue;
      const fileId = owningFile(node);
      state.relatedFiles.add(fileId);
      relationFiles.add(fileId);
      const source = incoming ? fileId : state.selectedFile;
      const target = incoming ? state.selectedFile : fileId;
      state.directFileEdges.add(fileEdgeKey(source, target, "calls"));
    }
  }

  function clearSelection() {
    state.selected = null;
    state.highlight = new Set();
    state.callers = new Set();
    state.callees = new Set();
    state.selectedFile = null;
    state.relatedFiles = new Set();
    state.callerFiles = new Set();
    state.calleeFiles = new Set();
    state.directFileEdges = new Set();
    document.getElementById("sidebar").hidden = true;
    state.dirty = true;
  }

  function textElement(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = String(value);
    return node;
  }

  function showSidebar(sym) {
    const el = document.getElementById("sidebar");
    const children = [
      textElement("h2", "", sym.name),
      textElement("div", "kind", sym.kind),
      textElement("div", "loc", `${sym.file}${sym.line != null ? `:${sym.line}` : ""}`),
    ];
    if (sym.signature) children.push(textElement("pre", "", sym.signature));
    if (sym.docstring) children.push(textElement("p", "", sym.docstring));
    el.replaceChildren(...children);
    el.hidden = false;
  }

  globalThis.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.selected) clearSelection();
      else if (state.expanded.size > 0) {
        state.expanded.clear();
        rebuildPickIndex();
      }
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
    if (!state.expanded.has(sym.parent)) {
      state.expanded.add(sym.parent);
      rebuildPickIndex();
    }
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
  for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const row = document.createElement("div");
    row.className = "row";
    const label = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "sw";
    swatch.style.backgroundColor = KIND_COLORS.get(kind) ?? "#c0caf5";
    label.append(swatch, document.createTextNode(String(kind)));
    row.append(label, textElement("span", "", count));
    legend.append(row);
  }

  document.getElementById("footer").textContent =
    `${model.meta.project} — ${model.meta.nodeCount} nodes, ${model.meta.edgeCount} edges, ${model.meta.fileCount} files — generated ${model.meta.generatedAt}`;
}
