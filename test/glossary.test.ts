import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, explain, parseVerbsAndNouns, setVerbsAndNouns } from '../src/ui/glossary.ts';

const list = (program: string) => readFileSync(`vendor/Apollo-11/${program}/ASSEMBLY_AND_OPERATION_INFORMATION.agc`, 'utf8');

test('verb and noun names come from each program’s own lists', () => {
  const lm = parseVerbsAndNouns(list('Luminary099'));
  assert.equal(lm.verbs.get('99'), 'PLEASE ENABLE ENGINE');
  assert.equal(lm.verbs.get('57'), 'PERMIT LANDING RADAR UPDATES');
  assert.equal(lm.verbs.get('37'), 'CHANGE PROGRAM (MAJOR MODE)');
  assert.equal(lm.nouns.get('18'), 'AUTO MANEUVER BALL ANGLES');
  assert.equal(lm.nouns.get('20'), 'ICDU ANGLES');
  assert.equal(lm.nouns.get('61'), 'TIME TO GO IN BRAKING PHASE');
  assert.equal(lm.nouns.get('62'), 'ABSOLUTE VALUE OF VELOCITY');
  assert.ok(!lm.nouns.has('19'), 'spare nouns are left out');
  const cm = parseVerbsAndNouns(list('Comanche055'));
  assert.equal(cm.nouns.get('20'), 'ICDU ANGLES');
  assert.equal(cm.nouns.get('62'), 'INERTIAL VEL MAG (VI)');
  assert.equal(cm.verbs.get('37'), 'CHANGE PROGRAM (MAJOR MODE)');
});

test('explain wraps the first use of each short form and every verb, noun and program number', () => {
  setVerbsAndNouns(list('Luminary099'), 'Luminary 099');
  assert.equal(describe('V99'), 'Verb 99, from Luminary 099’s verb list: PLEASE ENABLE ENGINE');
  assert.equal(describe('VERB 57'), describe('V57'));
  const html = explain('The LM & its IMU: V06 N61, then VERB 57 once the LM is low. P63 <ok>');
  assert.equal((html.match(/<abbr /g) ?? []).length, 6, html); // LM, IMU, V06, N61, VERB 57, P63
  assert.ok(html.includes('&amp; its') && html.includes('&lt;ok&gt;'), 'text is escaped');
  assert.ok(html.endsWith('&lt;ok&gt;'));
  assert.ok(/the LM is low/.test(html), 'the second LM stays plain');
  assert.equal(explain('PROGRAM and LMS stay plain'), 'PROGRAM and LMS stay plain');
});
