import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getOctOrDec } from '../src/yul/assembler.ts';
import { compareRope, parseBinsource } from '../src/yul/binsource.ts';
import { assembleProgram } from './helpers.ts';

test('YUL number syntax', () => {
  assert.equal(getOctOrDec('17'), 0o17);
  assert.equal(getOctOrDec('-17'), -0o17);
  assert.equal(getOctOrDec('17D'), 17);
  assert.equal(getOctOrDec('19'), 19);
  assert.equal(getOctOrDec('+2'), 2);
  assert.equal(getOctOrDec('A'), null);
  assert.equal(getOctOrDec('D'), null);
});

for (const id of ['Luminary099', 'Comanche055']) {
  test(`${id} assembles to the 1969 octal listing, word for word`, () => {
    const { result, corrections } = assembleProgram(id);
    assert.deepEqual(result.messages.filter((m) => m.fatal), []);
    assert.ok(corrections.every((c) => c.applied), 'all source corrections apply cleanly');
    const expected = parseBinsource(readFileSync(`test/fixtures/${id}.binsource`, 'utf8'));
    const { compared, mismatches } = compareRope(result.rope, result.used, expected);
    assert.equal(compared, 36 * 1024);
    assert.deepEqual(mismatches.slice(0, 5), []);
  });
}
