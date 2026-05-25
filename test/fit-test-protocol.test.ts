/**
 * Unit tests for the pure fit-test helpers — XML builders, the FITTEST/ALL
 * parser, and the snapshot diff. No I/O, no timers.
 */

import { describe, expect, it } from 'vitest';
import {
  buildNewTempDbXml,
  buildPersonXml,
  buildPollXml,
  buildProtocolXml,
  buildRespiratorXml,
  buildStartXml,
  buildStopXml,
  diffFitTestStatus,
  parseFitTestStatus,
  xmlEscape,
} from '../src/fit-test-protocol';
import type { FitTestProtocolDef } from '../src/fit-test-types';

describe('xmlEscape', () => {
  it('escapes &, <, >, single and double quotes', () => {
    expect(xmlEscape('A&B<C>D"E\'F')).toBe('A&amp;B&lt;C&gt;D&quot;E&apos;F');
  });
  it('passes through ordinary text', () => {
    expect(xmlEscape('hello world')).toBe('hello world');
  });
});

describe('builders', () => {
  it('buildNewTempDbXml is the documented constant', () => {
    expect(buildNewTempDbXml()).toBe('<MAIN><DATABASE><NEW_TEMP_DATABASE/></DATABASE></MAIN>');
  });

  it('buildPollXml / buildStopXml are the documented constants', () => {
    expect(buildPollXml()).toBe('<MAIN><FITTEST><ALL/></FITTEST></MAIN>');
    expect(buildStopXml()).toBe('<MAIN><FITTEST><STOP/></FITTEST></MAIN>');
  });

  it('buildPersonXml emits PEOPLEID=1, escapes user input, and includes empty CUSTOM slots', () => {
    const xml = buildPersonXml({
      lastName: 'O\'Brien',
      firstName: 'Mary <Anne>',
      idNumber: 'A&B',
    });
    expect(xml).toContain('<PEOPLEID>1</PEOPLEID>');
    expect(xml).toContain('<LASTNAME>O&apos;Brien</LASTNAME>');
    expect(xml).toContain('<FIRSTNAME>Mary &lt;Anne&gt;</FIRSTNAME>');
    expect(xml).toContain('<IDNUMBER>A&amp;B</IDNUMBER>');
    expect(xml).toContain('<COMPANY>Unknown</COMPANY>');
    expect(xml).toContain('<PEOPLENOTE>No information</PEOPLENOTE>');
    expect(xml).toContain('<CUSTOM1LABEL></CUSTOM1LABEL>');
    expect(xml).toContain('<CUSTOM4DATA></CUSTOM4DATA>');
  });

  it('buildRespiratorXml emits RESPIRATORID=1 with N95ENABLE as True/False', () => {
    const xml = buildRespiratorXml({
      manufacturer: '3M',
      model: '8511',
      passLevel: 100,
      n95Enable: true,
    });
    expect(xml).toContain('<RESPIRATORID>1</RESPIRATORID>');
    expect(xml).toContain('<MANUFACTURER>3M</MANUFACTURER>');
    expect(xml).toContain('<MASKMODEL>8511</MASKMODEL>');
    expect(xml).toContain('<FFPASSLEVEL>100</FFPASSLEVEL>');
    expect(xml).toContain('<N95ENABLE>True</N95ENABLE>');
  });

  it('buildProtocolXml pads to 12 exercises with EXCLUDE=True placeholders', () => {
    const proto: FitTestProtocolDef = {
      name: 'Quick',
      model: '8030',
      n95Enable: false,
      ambientPurgeSec: 4,
      ambientSampleSec: 5,
      maskPurgeSec: 11,
      periodSec: 6,
      endOnExerciseFail: false,
      exercises: [
        { name: 'Normal Breathing', excluded: false, maskSampleSec: 40 },
        { name: 'Deep Breathing', excluded: false, maskSampleSec: 40 },
      ],
    };
    const xml = buildProtocolXml(proto, '8030');
    expect(xml).toMatch(/^<MAIN><DATABASE><PROTOCOL Command="WRITE">/);
    expect(xml).toContain('<PROTOCOLNAME>Quick</PROTOCOLNAME>');
    expect(xml).toContain('<MODEL>8030</MODEL>');
    expect(xml).toContain('<N95ENABLE>False</N95ENABLE>');
    expect(xml).toContain('<AMBIENTPURGE>4</AMBIENTPURGE>');
    expect(xml).toContain('<AMBIENTSAMPLE>5</AMBIENTSAMPLE>');
    expect(xml).toContain('<MASKPURGE>11</MASKPURGE>');
    expect(xml).toContain('<EXERCISE1>Normal Breathing</EXERCISE1>');
    expect(xml).toContain('<EXERCISE2>Deep Breathing</EXERCISE2>');
    expect(xml).toContain('<EXERCISE3></EXERCISE3>');
    expect(xml).toContain('<EXERCISE12></EXERCISE12>');
    expect(xml).toContain('<EXCLUDE1>False</EXCLUDE1>');
    expect(xml).toContain('<EXCLUDE3>True</EXCLUDE3>');
    expect(xml).toContain('<EXCLUDE12>True</EXCLUDE12>');
    expect(xml).toContain('<MASKSAMPLE1>40</MASKSAMPLE1>');
    expect(xml).toContain('<MASKSAMPLE3>0</MASKSAMPLE3>');
    expect(xml).toContain('<MASKSAMPLE12>0</MASKSAMPLE12>');
    expect(xml).toMatch(/<\/PROTOCOL><\/DATABASE><\/MAIN>$/);
  });

  it('buildProtocolXml throws on more than 12 exercises', () => {
    const exercises = Array.from({ length: 13 }, (_, n) => ({
      name: `e${n}`, excluded: false, maskSampleSec: 1,
    }));
    expect(() => buildProtocolXml({
      name: 'too-many', model: '8030', n95Enable: false,
      ambientPurgeSec: 0, ambientSampleSec: 0, maskPurgeSec: 0,
      periodSec: 0, endOnExerciseFail: false,
      exercises,
    }, '8030')).toThrow(/too many exercises/);
  });

  it('buildStartXml carries the atomic ID writes plus START', () => {
    const xml = buildStartXml({
      maskSize: 'M',
      operator: 'rnewman',
      endOnOverallFFUnachievable: true,
    });
    expect(xml).toContain('<PEOPLEID Command="WRITE">1</PEOPLEID>');
    expect(xml).toContain('<PROTOCOLID Command="WRITE">1</PROTOCOLID>');
    expect(xml).toContain('<RESPIRATORID Command="WRITE">1</RESPIRATORID>');
    expect(xml).toContain('<MASKSIZE Command="WRITE">M</MASKSIZE>');
    expect(xml).toContain('<OPERATOR Command="WRITE">rnewman</OPERATOR>');
    expect(xml).toContain('<OVERALL_FF_UNACHIEVABLE_ENABLE Command="WRITE">True</OVERALL_FF_UNACHIEVABLE_ENABLE>');
    expect(xml).toContain('<START/>');
  });
});

describe('parseFitTestStatus', () => {
  const idleXml = `<MAIN><FITTEST>
    <NEWDATA>false</NEWDATA>
    <MSG_MAIN></MSG_MAIN>
    <FF_OVERALL></FF_OVERALL>
    <FF_OVERALL_STATUS></FF_OVERALL_STATUS>
    <STATUS>IDLE</STATUS>
    <DONE>false</DONE>
    <ERROR></ERROR>
    <PROGRESS_PERCENT>0</PROGRESS_PERCENT>
    <EXERCISE_NUMBER>0</EXERCISE_NUMBER>
    <FF_PASSLEVEL>100</FF_PASSLEVEL>
    <AMB_CONC>0</AMB_CONC>
    <AMB_CONC_STATUS></AMB_CONC_STATUS>
    <MASK_CONC>0</MASK_CONC>
    <MASK_CONC_STATUS></MASK_CONC_STATUS>
    <SECONDS>0</SECONDS>
    <TOTAL_SECONDS>0</TOTAL_SECONDS>
    <LOW_ALCOHOL_WARNING>false</LOW_ALCOHOL_WARNING>
    <LOW_PARTICLE_WARNING>false</LOW_PARTICLE_WARNING>
  </FITTEST></MAIN>`;

  it('parses an IDLE pre-start snapshot with no EXERCISE entries', () => {
    const s = parseFitTestStatus(idleXml);
    expect(s.status).toBe('IDLE');
    expect(s.done).toBe(false);
    expect(s.ffOverall).toBe(null);
    expect(s.ffOverallStatus).toBeUndefined();
    expect(s.error).toBeUndefined();
    expect(s.ffPassLevel).toBe(100);
    expect(s.lowAlcoholWarning).toBe(false);
    expect(s.exercises).toHaveLength(12);
    expect(s.exercises[0].status).toBe('NOT_STARTED');
    expect(s.exercises[0].fitFactor).toBe(null);
  });

  const midTestXml = `<MAIN><FITTEST>
    <NEWDATA>true</NEWDATA>
    <MSG_MAIN>Mask sample</MSG_MAIN>
    <FF_OVERALL></FF_OVERALL>
    <STATUS>MASK_SAMPLE</STATUS>
    <DONE>false</DONE>
    <ERROR></ERROR>
    <PROGRESS_PERCENT>33</PROGRESS_PERCENT>
    <EXERCISE_NUMBER>1</EXERCISE_NUMBER>
    <FF_PASSLEVEL>100</FF_PASSLEVEL>
    <AMB_CONC>2500</AMB_CONC>
    <AMB_CONC_STATUS>PASS</AMB_CONC_STATUS>
    <MASK_CONC>25</MASK_CONC>
    <MASK_CONC_STATUS>TESTING</MASK_CONC_STATUS>
    <SECONDS>12</SECONDS>
    <TOTAL_SECONDS>72</TOTAL_SECONDS>
    <LOW_ALCOHOL_WARNING>false</LOW_ALCOHOL_WARNING>
    <LOW_PARTICLE_WARNING>false</LOW_PARTICLE_WARNING>
    <EXERCISE><INDEX>0</INDEX><NAME>Normal Breathing</NAME><FITFACTOR>102.3</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
    <EXERCISE><INDEX>1</INDEX><NAME>Deep Breathing</NAME><FITFACTOR></FITFACTOR><STATUS>TESTING</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
    <EXERCISE><INDEX>2</INDEX><NAME>Head Side-to-Side</NAME><FITFACTOR></FITFACTOR><STATUS>IDLE</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
  </FITTEST></MAIN>`;

  it('parses mid-test snapshot with per-exercise EXERCISE blocks', () => {
    const s = parseFitTestStatus(midTestXml);
    expect(s.status).toBe('MASK_SAMPLE');
    expect(s.progressPercent).toBe(33);
    expect(s.exerciseNumber).toBe(1);
    expect(s.ambConc).toBe(2500);
    expect(s.ambConcStatus).toBe('PASS');
    expect(s.maskConc).toBe(25);
    expect(s.maskConcStatus).toBe('TESTING');
    expect(s.seconds).toBe(12);
    expect(s.totalSeconds).toBe(72);

    expect(s.exercises[0]).toMatchObject({
      index: 0, name: 'Normal Breathing', fitFactor: 102.3, status: 'PASS', excluded: false,
    });
    expect(s.exercises[1]).toMatchObject({
      index: 1, name: 'Deep Breathing', fitFactor: null, status: 'TESTING', excluded: false,
    });
    expect(s.exercises[2]).toMatchObject({
      index: 2, name: 'Head Side-to-Side', fitFactor: null, status: 'NOT_STARTED', excluded: false,
    });
    // Indices 3..11 stay NOT_STARTED placeholders.
    expect(s.exercises[3].status).toBe('NOT_STARTED');
    expect(s.exercises[11].status).toBe('NOT_STARTED');
  });

  it('keeps top-level STATUS distinct from per-exercise STATUS', () => {
    const s = parseFitTestStatus(midTestXml);
    expect(s.status).toBe('MASK_SAMPLE');   // FITTEST-level
    expect(s.exercises[0].status).toBe('PASS'); // first exercise
  });

  const doneXml = `<MAIN><FITTEST>
    <NEWDATA>true</NEWDATA>
    <MSG_MAIN>Done</MSG_MAIN>
    <FF_OVERALL>198.4</FF_OVERALL>
    <FF_OVERALL_STATUS>PASS</FF_OVERALL_STATUS>
    <STATUS>IDLE</STATUS>
    <DONE>true</DONE>
    <ERROR></ERROR>
    <PROGRESS_PERCENT>100</PROGRESS_PERCENT>
    <EXERCISE_NUMBER>1</EXERCISE_NUMBER>
    <FF_PASSLEVEL>100</FF_PASSLEVEL>
    <AMB_CONC>2400</AMB_CONC>
    <MASK_CONC>14</MASK_CONC>
    <SECONDS>0</SECONDS>
    <TOTAL_SECONDS>180</TOTAL_SECONDS>
    <LOW_ALCOHOL_WARNING>false</LOW_ALCOHOL_WARNING>
    <LOW_PARTICLE_WARNING>false</LOW_PARTICLE_WARNING>
    <EXERCISE><INDEX>0</INDEX><NAME>Normal Breathing</NAME><FITFACTOR>200.2</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
    <EXERCISE><INDEX>1</INDEX><NAME>Deep Breathing</NAME><FITFACTOR>196.7</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
  </FITTEST></MAIN>`;

  it('parses DONE=true / FF_OVERALL=PASS terminal snapshot', () => {
    const s = parseFitTestStatus(doneXml);
    expect(s.done).toBe(true);
    expect(s.ffOverall).toBe(198.4);
    expect(s.ffOverallStatus).toBe('PASS');
    expect(s.exercises[0].status).toBe('PASS');
    expect(s.exercises[1].fitFactor).toBe(196.7);
  });

  const errorXml = `<MAIN><FITTEST>
    <NEWDATA>true</NEWDATA>
    <MSG_MAIN>Failed</MSG_MAIN>
    <FF_OVERALL>5.2</FF_OVERALL>
    <FF_OVERALL_STATUS>FAIL</FF_OVERALL_STATUS>
    <STATUS>IDLE</STATUS>
    <DONE>true</DONE>
    <ERROR>ERROR_OVERALL_FF_UNACHIEVABLE</ERROR>
    <PROGRESS_PERCENT>45</PROGRESS_PERCENT>
    <EXERCISE_NUMBER>1</EXERCISE_NUMBER>
    <FF_PASSLEVEL>100</FF_PASSLEVEL>
    <AMB_CONC>2400</AMB_CONC>
    <MASK_CONC>461</MASK_CONC>
    <SECONDS>0</SECONDS>
    <TOTAL_SECONDS>90</TOTAL_SECONDS>
    <LOW_ALCOHOL_WARNING>false</LOW_ALCOHOL_WARNING>
    <LOW_PARTICLE_WARNING>false</LOW_PARTICLE_WARNING>
    <EXERCISE><INDEX>0</INDEX><NAME>Normal Breathing</NAME><FITFACTOR>5.2</FITFACTOR><STATUS>FAIL</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
  </FITTEST></MAIN>`;

  it('parses error/terminate-overall-FF snapshot', () => {
    const s = parseFitTestStatus(errorXml);
    expect(s.error).toBe('ERROR_OVERALL_FF_UNACHIEVABLE');
    expect(s.ffOverallStatus).toBe('FAIL');
    expect(s.exercises[0].status).toBe('FAIL');
  });

  it('tolerates trailing \\r\\r and \\0 padding', () => {
    const s = parseFitTestStatus(idleXml + '\r\r\0\0');
    expect(s.status).toBe('IDLE');
  });

  it('promotes the active exercise to TESTING when device reports IDLE', () => {
    // Real device behavior: per-exercise STATUS stays IDLE for both
    // pre-start and the currently-running exercise. The host has to
    // synthesize TESTING from top-level STATUS + EXERCISE_NUMBER.
    const xml = `<MAIN><FITTEST>
      <STATUS>MASK_SAMPLE</STATUS>
      <DONE>false</DONE>
      <EXERCISE_NUMBER>1</EXERCISE_NUMBER>
      <FF_OVERALL></FF_OVERALL>
      <FF_PASSLEVEL>100</FF_PASSLEVEL>
      <AMB_CONC>3000</AMB_CONC>
      <MASK_CONC>20</MASK_CONC>
      <EXERCISE><INDEX>0</INDEX><NAME>Normal Breathing</NAME><FITFACTOR>201.00</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
      <EXERCISE><INDEX>1</INDEX><NAME>Deep Breathing</NAME><FITFACTOR>0.00</FITFACTOR><STATUS>IDLE</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
      <EXERCISE><INDEX>2</INDEX><NAME>Head Side-to-Side</NAME><FITFACTOR>0.00</FITFACTOR><STATUS>IDLE</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
    </FITTEST></MAIN>`;
    const s = parseFitTestStatus(xml);
    expect(s.exercises[0].status).toBe('PASS');
    expect(s.exercises[1].status).toBe('TESTING'); // synthesized
    expect(s.exercises[2].status).toBe('NOT_STARTED'); // unrun
  });

  it('does not synthesize TESTING when DONE=true', () => {
    // Even if the device is at IDLE+DONE with EXERCISE_NUMBER pointing
    // at a slot, the test is over — no row should claim it's running.
    const xml = `<MAIN><FITTEST>
      <STATUS>IDLE</STATUS>
      <DONE>true</DONE>
      <EXERCISE_NUMBER>1</EXERCISE_NUMBER>
      <FF_OVERALL>198.4</FF_OVERALL>
      <FF_OVERALL_STATUS>PASS</FF_OVERALL_STATUS>
      <FF_PASSLEVEL>100</FF_PASSLEVEL>
      <AMB_CONC>0</AMB_CONC>
      <MASK_CONC>0</MASK_CONC>
      <EXERCISE><INDEX>0</INDEX><NAME>Normal Breathing</NAME><FITFACTOR>200.2</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
      <EXERCISE><INDEX>1</INDEX><NAME>Deep Breathing</NAME><FITFACTOR>196.7</FITFACTOR><STATUS>PASS</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>
      <EXERCISE><INDEX>2</INDEX><NAME></NAME><FITFACTOR>0.00</FITFACTOR><STATUS>IDLE</STATUS><EXCLUDE>true</EXCLUDE></EXERCISE>
    </FITTEST></MAIN>`;
    const s = parseFitTestStatus(xml);
    expect(s.exercises[1].status).toBe('PASS');
    expect(s.exercises[2].status).toBe('NOT_STARTED');
  });

  it('treats ERROR=UNSET as no-error', () => {
    // The device sends `<ERROR>UNSET</ERROR>` as its "no error set"
    // sentinel. Only specific values are actionable; UNSET must
    // normalize to absent.
    const xml = `<MAIN><FITTEST>
      <STATUS>IDLE</STATUS>
      <DONE>true</DONE>
      <ERROR>UNSET</ERROR>
      <FF_OVERALL></FF_OVERALL>
      <FF_PASSLEVEL>100</FF_PASSLEVEL>
      <AMB_CONC>0</AMB_CONC>
      <MASK_CONC>0</MASK_CONC>
    </FITTEST></MAIN>`;
    const s = parseFitTestStatus(xml);
    expect(s.error).toBeUndefined();
  });
});

describe('diffFitTestStatus', () => {
  // Build minimal snapshots by parsing canned XMLs.
  function status(opts: { done?: boolean; ex: Array<{ name: string; ff: number | null; status: string }> }): ReturnType<typeof parseFitTestStatus> {
    const indexBlocks = opts.ex.map((e, i) =>
      `<EXERCISE><INDEX>${i}</INDEX><NAME>${e.name}</NAME><FITFACTOR>${e.ff ?? ''}</FITFACTOR><STATUS>${e.status}</STATUS><EXCLUDE>false</EXCLUDE></EXERCISE>`,
    ).join('\n');
    return parseFitTestStatus(`<MAIN><FITTEST>
      <STATUS>RUNNING</STATUS>
      <DONE>${opts.done ? 'true' : 'false'}</DONE>
      ${indexBlocks}
    </FITTEST></MAIN>`);
  }

  it('reports no completions when prev is null and next has only NOT_STARTED/TESTING', () => {
    const next = status({ ex: [{ name: 'A', ff: null, status: 'TESTING' }] });
    const d = diffFitTestStatus(null, next);
    expect(d.newlyCompleted).toEqual([]);
    expect(d.transitionedToDone).toBe(false);
  });

  it('reports a single newly-completed exercise when status transitions to PASS', () => {
    const prev = status({ ex: [{ name: 'A', ff: null, status: 'TESTING' }] });
    const next = status({ ex: [{ name: 'A', ff: 120, status: 'PASS' }] });
    const d = diffFitTestStatus(prev, next);
    expect(d.newlyCompleted).toHaveLength(1);
    expect(d.newlyCompleted[0]).toMatchObject({ index: 0, name: 'A', fitFactor: 120, status: 'PASS' });
  });

  it('is idempotent on identical snapshots', () => {
    const next = status({ ex: [{ name: 'A', ff: 120, status: 'PASS' }] });
    const d = diffFitTestStatus(next, next);
    expect(d.newlyCompleted).toEqual([]);
    expect(d.transitionedToDone).toBe(false);
  });

  it('detects transitionedToDone exactly once', () => {
    const prev = status({ done: false, ex: [{ name: 'A', ff: 120, status: 'PASS' }] });
    const next = status({ done: true, ex: [{ name: 'A', ff: 120, status: 'PASS' }] });
    expect(diffFitTestStatus(prev, next).transitionedToDone).toBe(true);
    expect(diffFitTestStatus(next, next).transitionedToDone).toBe(false);
  });

  it('handles a fresh start (prev=null) with all exercises already PASS', () => {
    // This case shouldn't happen on real hardware, but verify nothing
    // explodes: we still report each terminal exercise as newly-completed.
    const next = status({ ex: [
      { name: 'A', ff: 120, status: 'PASS' },
      { name: 'B', ff: 80, status: 'FAIL' },
    ] });
    const d = diffFitTestStatus(null, next);
    expect(d.newlyCompleted.map((e) => e.status)).toEqual(['PASS', 'FAIL']);
  });
});
