// Directory-depth z assignment ("soft strata").
// Runs after the 2D force layout: files start on normalized depth layers,
// then relax along z through aggregate edge attraction. No RNG: z
// initializes exactly at the layer, and per-tick deltas are computed
// Jacobi-style in fixed order, so results are deterministic.

export const Z_RANGE_FRACTION = 0.4;
export const MAX_LAYERS = 12;
export const Z_TICKS = 60;
export const LAYER_SPRING = 0.08;
export const EDGE_Z_STRENGTH = 0.02;

export function depthOf(file) {
  const path = file.file ?? "";
  return Math.min((path.match(/\//g) ?? []).length, MAX_LAYERS);
}

export function assignDepth(nodes, fileEdges) {
  const files = nodes.filter((n) => n.kind === "file");
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const f of files) {
    minX = Math.min(minX, f.x);
    maxX = Math.max(maxX, f.x);
    minY = Math.min(minY, f.y);
    maxY = Math.max(maxY, f.y);
  }
  const zTarget = Z_RANGE_FRACTION * Math.max(Math.max(maxX - minX, 1), Math.max(maxY - minY, 1));

  // Normalize by the shallowest depth so same-depth repos land flat at z = 0.
  const depths = new Map(files.map((f) => [f.id, depthOf(f)]));
  let minDepth = Infinity;
  for (const d of depths.values()) minDepth = Math.min(minDepth, d);
  if (!Number.isFinite(minDepth)) minDepth = 0;
  let maxDepth = 0;
  for (const [id, d] of depths) {
    const effective = d - minDepth;
    depths.set(id, effective);
    maxDepth = Math.max(maxDepth, effective);
  }
  const spacing = maxDepth > 0 ? zTarget / maxDepth : 0;

  const layerZ = new Map(files.map((f) => [f.id, depths.get(f.id) * spacing]));
  const z = new Map(files.map((f) => [f.id, layerZ.get(f.id)]));

  let maxWeight = 0;
  for (const e of fileEdges) maxWeight = Math.max(maxWeight, e.weight);

  for (let tick = 0; tick < Z_TICKS && maxDepth > 0; tick++) {
    const deltas = new Map(files.map((f) => [f.id, 0]));
    for (const f of files) {
      deltas.set(f.id, (layerZ.get(f.id) - z.get(f.id)) * LAYER_SPRING);
    }
    for (const e of fileEdges) {
      if (!z.has(e.source) || !z.has(e.target)) continue;
      const pull = (z.get(e.target) - z.get(e.source)) * EDGE_Z_STRENGTH * (e.weight / maxWeight);
      deltas.set(e.source, deltas.get(e.source) + pull / 2);
      deltas.set(e.target, deltas.get(e.target) - pull / 2);
    }
    // Clamp so many-edge files cannot overshoot the strata range.
    for (const f of files) {
      z.set(f.id, Math.min(Math.max(z.get(f.id) + deltas.get(f.id), 0), zTarget));
    }
  }

  for (const node of nodes) {
    node.z = node.kind === "file" ? (z.get(node.id) ?? 0) : (z.get(node.parent) ?? 0);
    if (!Number.isFinite(node.z)) {
      throw new Error(`assignDepth produced non-finite z for ${node.id}`);
    }
  }
  return nodes;
}
