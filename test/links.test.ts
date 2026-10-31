import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROGRAMS, sourceLink } from '../src/programs.ts';
import { assembleProgram } from './helpers.ts';

test('sourceLink builds GitHub URLs at a fixed commit', () => {
  const commit = 'e7576d50f7c279a707cfaa71be2020592dbf43a8';
  assert.equal(sourceLink(commit, 'Luminary099'), `https://github.com/chrislgarry/Apollo-11/tree/${commit}/Luminary099`);
  assert.equal(
    sourceLink(commit, 'Luminary099', 'BURN_BABY_BURN--MASTER_IGNITION_ROUTINE.agc'),
    `https://github.com/chrislgarry/Apollo-11/blob/${commit}/Luminary099/BURN_BABY_BURN--MASTER_IGNITION_ROUTINE.agc`,
  );
  assert.equal(
    sourceLink(commit, 'Comanche055', 'P32-P33_P72-P73.agc', 648),
    `https://github.com/chrislgarry/Apollo-11/blob/${commit}/Comanche055/P32-P33_P72-P73.agc#L648`,
  );
});

for (const program of PROGRAMS) {
  test(`${program.id}: every listed file exists upstream under its own name`, () => {
    const { result } = assembleProgram(program.id);
    for (const f of result.files) {
      assert.ok(existsSync(join('vendor/Apollo-11', program.directory, f.name)), `${f.name} would link to a missing file`);
    }
  });
}
