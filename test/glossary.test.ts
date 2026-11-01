import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, describeAlarm, explain, parseAlarms, parseVerbsAndNouns, setProgramLists } from '../src/ui/glossary.ts';

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
  setProgramLists(list('Luminary099'), 'Luminary 099');
  assert.equal(describe('V99'), 'Verb 99, from Luminary 099’s verb list: PLEASE ENABLE ENGINE');
  assert.equal(describe('VERB 57'), describe('V57'));
  const html = explain('The LM & its IMU: V06 N61, then VERB 57 once the LM is low. P63 <ok>');
  assert.equal((html.match(/<abbr /g) ?? []).length, 6, html); // LM, IMU, V06, N61, VERB 57, P63
  assert.ok(html.includes('&amp; its') && html.includes('&lt;ok&gt;'), 'text is escaped');
  assert.ok(html.endsWith('&lt;ok&gt;'));
  assert.ok(/the LM is low/.test(html), 'the second LM stays plain');
  assert.equal(explain('PROGRAM and LMS stay plain'), 'PROGRAM and LMS stay plain');
});

test('alarm codes come from each program’s own list, with what sets them and what the computer does', () => {
  const lm = parseAlarms(list('Luminary099'));
  assert.ok(lm.size > 80, `${lm.size} Luminary alarms`);
  assert.deepEqual(lm.get('01703')!.variants, [{ text: 'IGNITION TIME SLIPPED', setBy: 'MIDTOAVE', kind: 'alarm' }]);
  assert.equal(lm.get('01202')!.variants[0].kind, 'restart', '* marks a software restart');
  assert.equal(lm.get('00105')!.variants[0].kind, 'abort', '** marks an abandoned program');
  assert.equal(lm.get('00514')!.variants[0].kind, 'priority', 'P marks a priority alarm');
  // Lines without a code, or with the code again and the text indented, continue the line above.
  assert.equal(lm.get('00206')!.variants[0].text, 'ZERO ENCODE NOT ALLOWED WITH COARSE ALIGN + GIMBAL LOC');
  assert.equal(lm.get('00401')!.variants[0].setBy, 'INF ALIGN, IMU-2, FINDCDUW');
  assert.equal(lm.get('01107')!.variants[0].setBy, 'RESTART', 'a routine named again is not repeated');
  // 1406 is listed twice, set by two routines, with a note under it.
  const rootpsrs = lm.get('01406')!;
  assert.deepEqual(rootpsrs.variants.map((v) => [v.setBy, v.kind]), [['DESCENT GUIDANCE EQS.', 'alarm'], ['IGNITION ALGORITHM', 'abort']]);
  assert.match(rootpsrs.note, /^NOTE: 1406 IS A POODOO DURING THE IGNITION ALGORITHM AND AN ALARM/);

  // Comanche names the alarm routine in a last column instead.
  const cm = parseAlarms(list('Comanche055'));
  assert.ok(cm.size > 70, `${cm.size} Comanche alarms`);
  assert.equal(cm.get('01202')!.variants[0].kind, 'restart', 'BAILOUT');
  assert.equal(cm.get('01206')!.variants[0].kind, 'abort', 'POODOO');
  assert.equal(cm.get('00404')!.variants[0].kind, 'priority', 'PRIOLARM');
  assert.deepEqual(cm.get('00210')!.variants[0], { text: 'IMU NOT OPERATING', setBy: 'IMU MODE SWITCH, IMU-2, R02, P51', kind: 'alarm' });
});

test('explain and the DSKY describe alarm codes in words', () => {
  setProgramLists(list('Luminary099'), 'Luminary 099');
  assert.equal(describeAlarm('1703'), 'Alarm 01703, from Luminary 099’s alarm list: IGNITION TIME SLIPPED. Set by MIDTOAVE. The program carries on.');
  assert.equal(describe('alarm 1703'), describeAlarm('01703'));
  // FAILREG's bit 15 marks more alarms than it holds; the rest is the latest code.
  assert.match(describeAlarm('41406')!, /^Alarm 01406, .* The leading 4 means more alarms came than the computer has room for; this is the latest\.$/);
  assert.equal(describeAlarm('07070'), undefined);
  const html = explain('Alarm 1703: ignition slipped. Later, alarm 1406.');
  assert.equal((html.match(/<abbr title="Alarm 01/g) ?? []).length, 2, html);
});
