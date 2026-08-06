function rotate(x, y, z, yaw, pitch) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const x1 = x * cy - y * sy;
  const y1 = x * sy + y * cy;
  const y2 = y1 * cp - z * sp;
  const z2 = y1 * sp + z * cp;
  return [x1, y2, z2];
}

function project(node, cam) {
  const [px, py, depth] = rotate(node.x, node.y, node.z ?? 0, cam.yaw, cam.pitch);
  return [px * cam.k + cam.tx, py * cam.k + cam.ty, depth];
}

export { rotate, project };
