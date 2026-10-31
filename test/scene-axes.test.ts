import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matVec, quatFromAxisAngle, quatToMatrix, type Vec3 } from '../src/sim/attitude.ts';
import { quatToScene, toScene } from '../src/ui/scene-axes.ts';

test('simulation axes map to scene axes with y up and the LM facing forward', () => {
  const cases: [Vec3, Vec3][] = [
    [[1, 0, 0], [0, 1, 0]],
    [[0, 1, 0], [-1, 0, 0]],
    [[0, 0, 1], [0, 0, 1]],
  ];
  for (const [v, expected] of cases) {
    assert.ok(toScene(v).every((value, i) => value === expected[i]), `axis ${v}`);
  }
});

test('mapping a rotated vector agrees with rotating it by the mapped attitude', () => {
  const attitudes = [
    quatFromAxisAngle([1, 0, 0], Math.PI / 2),
    quatFromAxisAngle([0, 1, 0], -Math.PI / 3),
    quatFromAxisAngle([1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)], 1.17),
  ];
  const vectors: Vec3[] = [[1, 0, 0], [0, 2, -1], [-1.25, 0.5, 3]];
  for (const q of attitudes) {
    for (const v of vectors) {
      const expected = toScene(matVec(quatToMatrix(q), v));
      const actual = matVec(quatToMatrix(quatToScene(q)), toScene(v));
      for (let i = 0; i < 3; i++) {
        assert.ok(Math.abs(actual[i] - expected[i]) < 1e-12, `attitude ${q}, vector ${v}, component ${i}`);
      }
    }
  }
});
