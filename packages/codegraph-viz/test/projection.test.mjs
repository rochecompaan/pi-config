import { test } from "node:test";
import assert from "node:assert/strict";
import { rotate, project } from "../lib/projection.mjs";

test("top-down projection equals the 2D affine transform", () => {
  const cam = { yaw: 0, pitch: 0, k: 2, tx: 10, ty: 20 };
  assert.deepEqual(project({ x: 3, y: -2, z: 5 }, cam), [16, 16, 5]);
  assert.deepEqual(project({ x: 3, y: -2, z: -7 }, cam), [16, 16, -7]);
  assert.deepEqual(project({ x: 3, y: -2 }, cam), [16, 16, 0]);
});

test("yaw rotates points around the vertical axis", () => {
  const [x, y, z] = rotate(1, 0, 0, Math.PI / 2, 0);
  assert.ok(Math.abs(x) < 1e-12 && Math.abs(y - 1) < 1e-12 && z === 0);
});

test("pitch tilts world z onto the screen y axis", () => {
  const [x, y, z] = rotate(0, 0, 1, 0, Math.PI / 2);
  assert.ok(x === 0 && Math.abs(y + 1) < 1e-12 && Math.abs(z) < 1e-12);
});

test("depth increases with world z when tilted", () => {
  const cam = { yaw: 0, pitch: Math.PI / 4, k: 1, tx: 0, ty: 0 };
  const near = project({ x: 0, y: 0, z: 0 }, cam);
  const far = project({ x: 0, y: 0, z: 10 }, cam);
  assert.ok(far[2] > near[2]);
});
