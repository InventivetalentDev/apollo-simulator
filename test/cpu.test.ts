import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGC, MCT_PER_SECOND } from '../src/agc/cpu.ts';
import { pressKey, readDsky, releaseKey, type DskyKey } from '../src/agc/dsky.ts';
import { assembleProgram } from './helpers.ts';

function boot(id: string) {
  const { result } = assembleProgram(id);
  const agc = new AGC(result.rope);
  const run = (seconds: number) => agc.run(Math.round(seconds * MCT_PER_SECOND));
  const keys = (seq: string) => {
    for (const tok of seq.split(' ')) {
      const key = ({ V: 'VERB', N: 'NOUN', E: 'ENTR' } as Record<string, DskyKey>)[tok] ?? (tok as DskyKey);
      pressKey(agc, key);
      if (key === 'PRO') {
        run(0.3);
        releaseKey(agc, key);
      }
      run(0.15);
    }
  };
  const symbol = (name: string) => result.symbols.find((s) => s.name === name)!.value;
  return { agc, run, keys, symbol };
}

for (const id of ['Luminary099', 'Comanche055']) {
  test(`${id}: boots, runs the DSKY and keeps time`, () => {
    const { agc, run, keys } = boot(id);
    run(3);
    assert.equal(agc.restarts, 0);
    keys('V 0 5 N 0 9 E');
    run(0.5);
    assert.equal(readDsky(agc).r[0], ' 01107', 'fresh start with blank erasable memory raises alarm 1107');
    keys('RSET V 3 5 E');
    run(1);
    const lampTest = readDsky(agc);
    assert.deepEqual([lampTest.prog, lampTest.verb, lampTest.noun], ['88', '88', '88']);
    assert.deepEqual(lampTest.r, ['+88888', '+88888', '+88888']);
    assert.ok(lampTest.lamps.prog && lampTest.lamps.restart && lampTest.lamps.oprErr);
    run(6);
    keys('V 1 6 N 6 5 E');
    // The display is rewritten one relay word at a time, so wait for a settled reading.
    const settledSeconds = () => {
      let prev = '';
      for (;;) {
        run(0.1);
        const now = readDsky(agc).r[2];
        if (now === prev) return parseInt(now, 10) / 100;
        prev = now;
      }
    };
    run(1);
    const t1 = settledSeconds();
    run(3);
    const t2 = settledSeconds();
    assert.ok(t2 - t1 >= 2 && t2 - t1 <= 4.5, `clock advances about 3 s (got ${t1} -> ${t2})`);
    keys('V 3 7 E 0 0 E');
    run(2);
    assert.equal(readDsky(agc).prog, '00');
    assert.equal(agc.restarts, 0);
  });

  test(`${id}: passes the AGC's own self-check (instructions, erasable, rope checksums)`, () => {
    const { agc, run, keys, symbol } = boot(id);
    run(2);
    keys('RSET V 2 1 N 2 7 E 1 0 E');
    run(150);
    assert.equal(agc.mem[symbol('SMODE')], 0o10);
    assert.ok(agc.mem[symbol('SCOUNT')] >= 2, 'at least one complete self-check cycle');
    assert.equal(agc.mem[symbol('ERCOUNT')], 0, 'no self-check errors');
    assert.equal(agc.restarts, 0);
  });
}
