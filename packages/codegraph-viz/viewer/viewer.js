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
    yaw: 0, pitch: 0,
    mode3d: false,
    camera3d: { yaw: 0, pitch: Math.PI / 4 },
    degrading: false,
    pickDirty: true,
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
      const [px, py] = rotate(f.x, f.y, f.z ?? 0, state.yaw, state.pitch);
      minX = Math.min(minX, px - f.r);
      maxX = Math.max(maxX, px + f.r);
      minY = Math.min(minY, py - f.r);
      maxY = Math.max(maxY, py + f.r);
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
    const pts = [];
    for (const s of symbols) {
      if (!state.expanded.has(s.parent)) continue;
      const [x, y] = project(s, state);
      pts.push({ x, y, sym: s });
    }
    symbolTree = buildPointTree(pts);
    state.pickDirty = false;
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
  function nearestSymbol(sx, sy, maxDistPx) {
    if (state.pickDirty) rebuildPickIndex();
    let best = null, bestD = maxDistPx;
    (function visit(node) {
      if (!node) return;
      if (sx < node.x - bestD || sx > node.x + node.size + bestD) return;
      if (sy < node.y - bestD || sy > node.y + node.size + bestD) return;
      if (!node.children) {
        for (const point of node.points) {
          const d = Math.hypot(point.x - sx, point.y - sy);
          if (d < bestD) {
            best = point.sym;
            bestD = d;
          }
        }
      }
      if (node.children) for (const child of node.children) visit(child);
    })(symbolTree);
    return best;
  }

  // ---- transform helpers ----
  // rotate() and project() are globals from the projection source inlined
  // above this script. Camera fields live directly on `state`.
  // toWorld is only exact in top-down view (yaw=0, pitch=0); 3D zoom
  // anchors on the viewport center instead.
  const toWorld = (sx, sy) => [(sx - state.tx) / state.k, (sy - state.ty) / state.k];
  const topDown = () => state.yaw === 0 && state.pitch === 0;
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
    const cull2d = topDown();
    const rect = cull2d ? visibleWorldRect() : null;
    const dimOthers = state.selected !== null;

    // Projection cache for this render pass.
    const proj = new Map();
    const P = (n) => {
      let p = proj.get(n.id);
      if (!p) {
        p = project(n, state);
        proj.set(n.id, p);
      }
      return p;
    };
    const visible = (n, worldPad) => {
      if (cull2d) return inRect(rect, n.x, n.y, worldPad);
      const [px, py] = P(n);
      const pad = worldPad * state.k + 20;
      return px >= -pad && px <= vw + pad && py >= -pad && py <= vh + pad;
    };

    // Painter-ordered node list (far first) and depth range for fading.
    const drawList = [];
    for (const f of files) {
      if (visible(f, f.r * 1.2)) drawList.push({ depth: P(f)[2], isFile: true, node: f });
    }
    if (!state.degrading) {
      for (const s of symbols) {
        if (!state.expanded.has(s.parent)) continue;
        if (visible(s, 20)) drawList.push({ depth: P(s)[2], isFile: false, node: s });
      }
    }
    // Painter order only in 3D: at top-down, insertion order (files in
    // payload order, then symbols) reproduces the pre-3D draw order exactly.
    if (!cull2d) drawList.sort((a, b) => a.depth - b.depth);
    let minDepth = Infinity, maxDepth = -Infinity;
    for (const item of drawList) {
      minDepth = Math.min(minDepth, item.depth);
      maxDepth = Math.max(maxDepth, item.depth);
    }
    if (minDepth > maxDepth) { minDepth = 0; maxDepth = 1; }
    const depthSpan = Math.max(maxDepth - minDepth, 1e-9);
    // Clamp: edge endpoints can sit outside the visible depth range (culled
    // nodes, or symbols excluded during degrade drags); out-of-range
    // globalAlpha assignments are silently ignored by Canvas.
    const depthFade = (d) => cull2d ? 1 : Math.min(Math.max(0.45 + 0.55 * ((d - minDepth) / depthSpan), 0), 1);

    const drawFile = (f, [sx, sy, depth]) => {
      const baseColor = dirColor.get(f.dir.split("/")[0] || ".") ?? "#7aa2f7";
      const color = f.id === state.selectedFile ? "#ffffff"
        : state.callerFiles.has(f.id) ? CALLER_COLOR
          : state.calleeFiles.has(f.id) ? CALLEE_COLOR : baseColor;
      const related = state.relatedFiles.has(f.id);
      ctx.globalAlpha = (dimOthers ? (related ? 0.95 : 0.12) : 1) * depthFade(depth);
      if (state.expanded.has(f.id)) {
        const rx = f.r * state.k;
        // Floor the squashed axis only when tilted; at pitch 0 the ellipse
        // must equal the pre-3D circle exactly, even for rx < 1.
        const ry = state.pitch === 0 ? rx : Math.max(rx * Math.cos(state.pitch), 1);
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        if (!state.degrading) {
          ctx.fillStyle = color;
          ctx.font = "12px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(f.name, sx, sy - ry - 6);
        }
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sx, sy, pr, 0, Math.PI * 2);
        ctx.fill();
        if (state.k >= 0.6 && !state.degrading) {
          ctx.fillStyle = "#c0caf5";
          ctx.font = "11px system-ui";
          ctx.textAlign = "center";
          ctx.fillText(f.name, sx, sy - pr - 5);
        }
      }
    };

    const drawSymbol = (s, [sx, sy, depth]) => {
      const isSelected = state.selected === s.id;
      const isHighlighted = state.highlight.has(s.id);
      ctx.globalAlpha = (dimOthers ? (isSelected || isHighlighted ? 1 : 0.15) : 1) * depthFade(depth);
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
    };

    // Aggregated file context follows the same kind toggles as detail edges.
    ctx.lineWidth = 1;
    for (const e of model.fileEdges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = fileById.get(e.source);
      const target = fileById.get(e.target);
      if (!source || !target) continue;
      if (!visible(source, source.r) && !visible(target, target.r)) continue;
      const [sx, sy, sd] = P(source);
      const [tx, ty, td] = P(target);
      const directContext = state.directFileEdges.has(fileEdgeKey(e.source, e.target, e.kind));
      ctx.strokeStyle = EDGE_COLORS.get(e.kind) ?? "#565f89";
      ctx.globalAlpha = (dimOthers ? (directContext ? 0.75 : 0.025) : 0.15) * depthFade((sd + td) / 2);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    // Detail edges require both owning files expanded; file<->file stays aggregated.
    for (const e of model.edges) {
      if (!state.enabledEdges.has(e.kind)) continue;
      const source = nodeById.get(e.source);
      const target = nodeById.get(e.target);
      if (!source || !target || (source.kind === "file" && target.kind === "file")) continue;
      if (!state.expanded.has(owningFile(source)) || !state.expanded.has(owningFile(target))) continue;
      if (!visible(source, 20) && !visible(target, 20)) continue;
      const [sx, sy, sd] = P(source);
      const [tx, ty, td] = P(target);
      const selectedCall = e.kind === "calls" && (state.selected === source.id || state.selected === target.id);
      ctx.strokeStyle = selectedCall
        ? (state.selected === target.id ? CALLER_COLOR : CALLEE_COLOR)
        : (EDGE_COLORS.get(e.kind) ?? "#565f89");
      ctx.globalAlpha = (dimOthers ? (selectedCall ? 0.9 : 0.06) : 0.35) * depthFade((sd + td) / 2);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(tx, ty);
      ctx.stroke();
    }

    for (const item of drawList) {
      if (item.isFile) drawFile(item.node, P(item.node));
      else drawSymbol(item.node, P(item.node));
    }
    ctx.globalAlpha = 1;
  }

  function frame() {
    render();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ---- interaction ----
  const PITCH_MAX = (80 * Math.PI) / 180;
  let dragStart = null, dragged = false;
  canvas.addEventListener("pointerdown", (e) => {
    dragStart = {
      x: e.clientX, y: e.clientY,
      tx: state.tx, ty: state.ty,
      yaw: state.yaw, pitch: state.pitch,
      rotate: state.mode3d && e.button === 0 && !e.shiftKey,
    };
    dragged = false;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
    if (dragStart.rotate) {
      state.yaw = dragStart.yaw + dx * 0.01;
      state.pitch = Math.min(Math.max(dragStart.pitch + dy * 0.01, 0), PITCH_MAX);
      state.degrading = dragged;
    } else {
      state.tx = dragStart.tx + dx;
      state.ty = dragStart.ty + dy;
    }
    state.pickDirty = true;
    state.dirty = true;
  });
  const endDrag = (e, allowClick) => {
    if (dragStart && allowClick && !dragged) onClick(e.clientX, e.clientY);
    // Same guard as the toggle: plain clicks (or drags ending exactly
    // top-down) must not clobber the remembered 3D tilt.
    if (dragStart?.rotate && !topDown()) state.camera3d = { yaw: state.yaw, pitch: state.pitch };
    dragStart = null;
    state.degrading = false;
    state.dirty = true;
  };
  canvas.addEventListener("pointerup", (e) => endDrag(e, true));
  canvas.addEventListener("pointercancel", (e) => endDrag(e, false));
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());
  canvas.addEventListener("dblclick", (e) => {
    // Only empty space resets the camera: double-clicking a node is
    // navigation (its two click events already expanded/selected it).
    if (nearestSymbol(e.clientX, e.clientY, 8)) return;
    for (const f of files) {
      const [fx, fy] = project(f, state);
      const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
      if (Math.hypot(fx - e.clientX, fy - e.clientY) <= pr + 2) return;
    }
    state.yaw = 0;
    state.pitch = 0;
    state.camera3d = { yaw: 0, pitch: Math.PI / 4 };
    fitToContent();
    state.pickDirty = true;
    state.dirty = true;
  });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0012);
    if (topDown()) {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      state.k = Math.min(Math.max(state.k * factor, 0.05), 40);
      state.tx = e.clientX - wx * state.k;
      state.ty = e.clientY - wy * state.k;
    } else {
      // No exact inverse under rotation: zoom around the viewport center.
      const cx = vw / 2, cy = vh / 2;
      const wx = (cx - state.tx) / state.k;
      const wy = (cy - state.ty) / state.k;
      state.k = Math.min(Math.max(state.k * factor, 0.05), 40);
      state.tx = cx - wx * state.k;
      state.ty = cy - wy * state.k;
    }
    state.pickDirty = true;
    state.dirty = true;
  }, { passive: false });

  function onClick(sx, sy) {
    const sym = nearestSymbol(sx, sy, 8);
    if (sym) {
      selectSymbol(sym);
      return;
    }
    let hit = null;
    for (const f of files) {
      const [fx, fy] = project(f, state);
      const distance = Math.hypot(fx - sx, fy - sy);
      if (state.expanded.has(f.id)) {
        const rx = f.r * state.k;
        const ry = state.pitch === 0 ? rx : Math.max(rx * Math.cos(state.pitch), 1);
        const norm = ((sx - fx) / rx) ** 2 + ((sy - fy) / ry) ** 2;
        if (Math.abs(Math.sqrt(norm) - 1) * Math.min(rx, ry) <= 8) {
          hit = f;
          break;
        }
      } else {
        const pr = 4 + 3 * Math.sqrt(Math.max(f.size, 1));
        if (distance <= pr + 2) {
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
    const [px, py] = rotate(node.x, node.y, node.z ?? 0, state.yaw, state.pitch);
    state.tx = vw / 2 - px * state.k;
    state.ty = vh / 2 - py * state.k;
    state.pickDirty = true;
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

  const modeButton = document.createElement("button");
  modeButton.id = "mode3d";
  modeButton.type = "button";
  modeButton.textContent = "3D";
  modeButton.title = "Toggle rotatable 3D overview";
  modeButton.setAttribute("aria-pressed", "false");
  modeButton.addEventListener("click", () => {
    state.mode3d = !state.mode3d;
    modeButton.setAttribute("aria-pressed", String(state.mode3d));
    if (state.mode3d) {
      state.yaw = state.camera3d.yaw;
      state.pitch = state.camera3d.pitch;
    } else {
      // Only remember angles worth restoring: a top-down camera (e.g. right
      // after a dblclick reset) must not clobber the remembered 3D tilt.
      if (!topDown()) state.camera3d = { yaw: state.yaw, pitch: state.pitch };
      state.yaw = 0;
      state.pitch = 0;
    }
    fitToContent();
    state.pickDirty = true;
    state.dirty = true;
  });
  document.getElementById("hud").append(modeButton);

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
