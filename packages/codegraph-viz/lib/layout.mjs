// Deterministic two-phase force layout.
// Phase 1 lays out file centers over aggregated file→file edges.
// Phase 2 lays out each file's symbols in that file's local frame.
// All randomness comes from one seeded PRNG; tick budgets are fixed.

import { assignDepth } from "./depth-layout.mjs";

export function computeLayout(model) {
  const rng = mulberry32(0xc0ffee);
  const files = model.nodes.filter((n) => n.kind === "file");

  const fileBodies = files.map((file) => ({
    id: file.id,
    x: (rng() - 0.5) * 400,
    y: (rng() - 0.5) * 400,
    vx: 0,
    vy: 0,
    mass: 1 + file.size,
  }));
  const fileLinks = model.fileEdges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    weight: edge.weight,
  }));
  simulate(fileBodies, fileLinks, {
    ticks: 400,
    charge: -300,
    linkDistance: 120,
    linkStrength: 0.03,
    gravity: 0.01,
    rng,
  });
  const filePos = new Map(fileBodies.map((body) => [body.id, body]));

  const symbolsByParent = new Map();
  for (const node of model.nodes) {
    if (node.kind === "file") continue;
    if (!symbolsByParent.has(node.parent)) symbolsByParent.set(node.parent, []);
    symbolsByParent.get(node.parent).push(node);
  }
  const localCallLinksByFile = indexLocalCallLinks(model.nodes, model.edges);

  for (const file of files) {
    const center = filePos.get(file.id);
    const r = fileRadius(file.size);
    file.x = center.x;
    file.y = center.y;
    file.r = r;

    const symbols = symbolsByParent.get(file.id) ?? [];
    if (symbols.length === 0) continue;
    if (symbols.length === 1) {
      symbols[0].x = center.x;
      symbols[0].y = center.y;
      continue;
    }

    const localLinks = localCallLinksByFile.get(file.id) ?? [];
    const bodies = symbols.map((symbol) => ({
      id: symbol.id,
      x: (rng() - 0.5) * r,
      y: (rng() - 0.5) * r,
      vx: 0,
      vy: 0,
      mass: 1,
    }));
    simulate(bodies, localLinks, {
      ticks: 150,
      charge: -60,
      linkDistance: r * 0.4,
      linkStrength: 0.05,
      gravity: 0.2,
      rng,
    });

    let maxD = 0;
    for (const body of bodies) maxD = Math.max(maxD, Math.hypot(body.x, body.y));
    const scale = maxD > 0 ? Math.min(1, (r * 0.9) / maxD) : 1;
    const posById = new Map(bodies.map((body) => [body.id, body]));
    for (const symbol of symbols) {
      const body = posById.get(symbol.id);
      symbol.x = center.x + body.x * scale;
      symbol.y = center.y + body.y * scale;
    }
  }

  assignDepth(model.nodes, model.fileEdges);
  return model;
}

export function fileRadius(symbolCount) {
  return 30 + 14 * Math.sqrt(Math.max(symbolCount, 1));
}

export function indexLocalCallLinks(nodes, edges) {
  const parentBySymbol = new Map();
  for (const node of nodes) {
    if (node.kind !== "file") parentBySymbol.set(node.id, node.parent);
  }

  const linksByFile = new Map();
  for (const edge of edges) {
    if (edge.kind !== "calls") continue;
    const sourceFile = parentBySymbol.get(edge.source);
    const targetFile = parentBySymbol.get(edge.target);
    if (sourceFile == null || sourceFile !== targetFile) continue;
    if (!linksByFile.has(sourceFile)) linksByFile.set(sourceFile, []);
    linksByFile.get(sourceFile).push({ source: edge.source, target: edge.target, weight: 1 });
  }
  return linksByFile;
}

function simulate(bodies, links, { ticks, charge, linkDistance, linkStrength, gravity, rng }) {
  const byId = new Map(bodies.map((body) => [body.id, body]));
  for (let tick = 0; tick < ticks; tick++) {
    const alpha = 1 - tick / ticks;
    applyRepulsion(bodies, charge, alpha);
    for (const link of links) {
      const source = byId.get(link.source);
      const target = byId.get(link.target);
      if (!source || !target) continue;
      let dx = target.x - source.x;
      let dy = target.y - source.y;
      let distance = Math.hypot(dx, dy);
      if (distance === 0) {
        dx = (rng() - 0.5) * 0.01;
        dy = (rng() - 0.5) * 0.01;
        distance = Math.hypot(dx, dy);
      }
      const force = (distance - linkDistance) * linkStrength * Math.min(link.weight ?? 1, 5) * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      source.vx += fx / source.mass;
      source.vy += fy / source.mass;
      target.vx -= fx / target.mass;
      target.vy -= fy / target.mass;
    }
    for (const body of bodies) {
      body.vx -= body.x * gravity * alpha;
      body.vy -= body.y * gravity * alpha;
      body.vx *= 0.6;
      body.vy *= 0.6;
      const speed = Math.hypot(body.vx, body.vy);
      if (speed > 10) {
        body.vx = (body.vx / speed) * 10;
        body.vy = (body.vy / speed) * 10;
      }
      body.x += body.vx;
      body.y += body.vy;
    }
  }
}

// Barnes-Hut repulsion over a quadtree with center-of-mass (theta 0.8).
function applyRepulsion(bodies, charge, alpha) {
  if (bodies.length < 2) return;
  const root = buildQuadtree(bodies);
  for (const body of bodies) applyTreeForce(root, body, charge, alpha);
}

function buildQuadtree(bodies) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const body of bodies) {
    minX = Math.min(minX, body.x);
    minY = Math.min(minY, body.y);
    maxX = Math.max(maxX, body.x);
    maxY = Math.max(maxY, body.y);
  }
  const size = Math.max(maxX - minX, maxY - minY, 1);
  const root = quad(minX, minY, size);
  for (const body of bodies) insertPoint(root, body);
  computeMass(root);
  return root;
}

function quad(x, y, size) {
  return { x, y, size, body: null, children: null, mass: 0, cx: 0, cy: 0 };
}

function insertPoint(node, body) {
  if (!node.body && !node.children) {
    node.body = body;
    return;
  }
  if (!node.children) {
    const half = node.size / 2;
    node.children = [
      quad(node.x, node.y, half),
      quad(node.x + half, node.y, half),
      quad(node.x, node.y + half, half),
      quad(node.x + half, node.y + half, half),
    ];
    const existing = node.body;
    node.body = null;
    insertPoint(childFor(node, existing), existing);
  }
  insertPoint(childFor(node, body), body);
}

function childFor(node, body) {
  const right = body.x >= node.x + node.size / 2 ? 1 : 0;
  const bottom = body.y >= node.y + node.size / 2 ? 2 : 0;
  return node.children[right + bottom];
}

function computeMass(node) {
  if (!node.children) {
    if (node.body) {
      node.mass = node.body.mass;
      node.cx = node.body.x;
      node.cy = node.body.y;
    }
    return;
  }
  for (const child of node.children) computeMass(child);
  for (const child of node.children) {
    node.mass += child.mass;
    node.cx += child.cx * child.mass;
    node.cy += child.cy * child.mass;
  }
  if (node.mass > 0) {
    node.cx /= node.mass;
    node.cy /= node.mass;
  }
}

function applyTreeForce(node, body, charge, alpha) {
  const THETA2 = 0.64;
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.mass === 0) continue;
    const dx = current.cx - body.x;
    const dy = current.cy - body.y;
    let d2 = dx * dx + dy * dy;
    if (!current.children) {
      if (current.body === body || d2 === 0) continue;
      repel(body, dx, dy, d2, charge * current.mass, alpha);
      continue;
    }
    if ((current.size * current.size) / Math.max(d2, 1e-6) < THETA2) {
      d2 = Math.max(d2, 4);
      repel(body, dx, dy, d2, charge * current.mass, alpha);
    } else {
      for (const child of current.children) stack.push(child);
    }
  }
}

function repel(body, dx, dy, d2, k, alpha) {
  const distance = Math.sqrt(d2);
  const force = (k / d2) * alpha;
  body.vx += (dx / distance) * force;
  body.vy += (dy / distance) * force;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
