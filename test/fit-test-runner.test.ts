/**
 * Orchestration tests for FitTestRunner.
 *
 * Uses a stub Portacount that returns canned XML for each command. Fake
 * timers drive the poll interval so a long test runs in milliseconds.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FitTestAbortedError, FitTestRunner } from '../src/fit-test-runner';
import type { Portacount } from '../src/portacount';
import type {
  ExerciseResult,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestStartOptions,
  FitTestStatus,
} from '../src/fit-test-types';

const STOCK_PERSON: FitTestPerson = {
  lastName: 'Doe',
  firstName: 'John',
  idNumber: '42',
};
const STOCK_MASK: FitTestMask = {
  manufacturer: '3M',
  model: '8511',
  passLevel: 100,
  n95Enable: true,
};
const STOCK_PROTOCOL: FitTestProtocolDef = {
  name: 'Quick',
  model: '8030',
  n95Enable: true,
  ambientPurgeSec: 4,
  ambientSampleSec: 5,
  maskPurgeSec: 11,
  periodSec: 6,
  endOnExerciseFail: false,
  exercises: [
    { name: 'Normal Breathing', excluded: false, maskSampleSec: 30 },
    { name: 'Deep Breathing', excluded: false, maskSampleSec: 30 },
  ],
};
const STOCK_START: FitTestStartOptions = {
  maskSize: 'M',
  operator: 'rnewman',
  endOnOverallFFUnachievable: true,
};

/** A minimal stub of Portacount that records every command and pops a
 * canned response. */
class StubPortacount {
  /** Every command the runner has sent, in order. */
  readonly commands: string[] = [];
  /** Queue of canned poll responses, popped per FITTEST/ALL call. */
  pollResponses: string[] = [];
  /** Override the response for a specific command substring. */
  readonly overrides = new Map<string, string>();
  /** When set, the next matching command rejects with this error. */
  rejectNextFor: { match: string; error: Error } | null = null;

  command(xml: string, _timeoutMs?: number): Promise<string> {
    this.commands.push(xml);
    if (this.rejectNextFor && xml.includes(this.rejectNextFor.match)) {
      const err = this.rejectNextFor.error;
      this.rejectNextFor = null;
      return Promise.reject(err);
    }
    for (const [needle, response] of this.overrides) {
      if (xml.includes(needle)) return Promise.resolve(response);
    }
    if (xml.includes('<FITTEST><ALL/>')) {
      const r = this.pollResponses.shift();
      if (r === undefined) {
        // No more responses scripted. Return a benign IDLE+DONE so
        // a runner doesn't hang forever in tests that under-script.
        return Promise.resolve(idleDoneResponse());
      }
      return Promise.resolve(r);
    }
    if (xml.includes('<NEW_TEMP_DATABASE/>')) {
      return Promise.resolve('<MAIN><DATABASE><NEW_TEMP_DATABASE>OK</NEW_TEMP_DATABASE></DATABASE></MAIN>');
    }
    if (xml.includes('<PEOPLE Command="WRITE">')) {
      return Promise.resolve('<MAIN><DATABASE><PEOPLE><PEOPLEID>1</PEOPLEID></PEOPLE></DATABASE></MAIN>');
    }
    if (xml.includes('<RESPIRATOR Command="WRITE">')) {
      return Promise.resolve('<MAIN><DATABASE><RESPIRATOR><RESPIRATORID>1</RESPIRATORID></RESPIRATOR></DATABASE></MAIN>');
    }
    if (xml.includes('<PROTOCOL Command="WRITE">')) {
      return Promise.resolve('<MAIN><DATABASE><PROTOCOL><PROTOCOLID>1</PROTOCOLID></PROTOCOL></DATABASE></MAIN>');
    }
    if (xml.includes('<FITTEST><STOP/>')) {
      return Promise.resolve('<MAIN><FITTEST><STOP>OK</STOP></FITTEST></MAIN>');
    }
    if (xml.includes('<START/>') && xml.includes('<FITTEST>')) {
      return Promise.resolve('<MAIN><FITTEST>OK</FITTEST></MAIN>');
    }
    return Promise.resolve('<MAIN></MAIN>');
  }

  asPortacount(): Portacount {
    // The runner only uses pc.command — safe to cast.
    return this as unknown as Portacount;
  }
}

interface FittestXmlBlock {
  index: number;
  name: string;
  ff?: number | string;
  status: 'NOT_STARTED' | 'TESTING' | 'PASS' | 'FAIL' | 'EXCLUDED';
  exclude?: boolean;
}

function fittestResponse(opts: {
  status: string;
  done?: boolean;
  ffOverall?: number | string;
  ffOverallStatus?: 'PASS' | 'FAIL' | '';
  error?: string;
  exerciseNumber?: number;
  ambConc?: number;
  ambStatus?: 'PASS' | 'FAIL' | 'TESTING' | '';
  maskConc?: number;
  maskStatus?: 'PASS' | 'FAIL' | 'TESTING' | '';
  blocks?: FittestXmlBlock[];
}): string {
  const blocks = (opts.blocks ?? [])
    .map((b) =>
      `<EXERCISE><INDEX>${b.index}</INDEX><NAME>${b.name}</NAME><FITFACTOR>${b.ff ?? ''}</FITFACTOR><STATUS>${b.status}</STATUS><EXCLUDE>${b.exclude ? 'true' : 'false'}</EXCLUDE></EXERCISE>`,
    )
    .join('');
  return `<MAIN><FITTEST>
    <NEWDATA>true</NEWDATA>
    <MSG_MAIN></MSG_MAIN>
    <FF_OVERALL>${opts.ffOverall ?? ''}</FF_OVERALL>
    <FF_OVERALL_STATUS>${opts.ffOverallStatus ?? ''}</FF_OVERALL_STATUS>
    <STATUS>${opts.status}</STATUS>
    <DONE>${opts.done ? 'true' : 'false'}</DONE>
    <ERROR>${opts.error ?? ''}</ERROR>
    <PROGRESS_PERCENT>0</PROGRESS_PERCENT>
    <EXERCISE_NUMBER>${opts.exerciseNumber ?? 0}</EXERCISE_NUMBER>
    <FF_PASSLEVEL>100</FF_PASSLEVEL>
    <AMB_CONC>${opts.ambConc ?? 0}</AMB_CONC>
    <AMB_CONC_STATUS>${opts.ambStatus ?? ''}</AMB_CONC_STATUS>
    <MASK_CONC>${opts.maskConc ?? 0}</MASK_CONC>
    <MASK_CONC_STATUS>${opts.maskStatus ?? ''}</MASK_CONC_STATUS>
    <SECONDS>0</SECONDS>
    <TOTAL_SECONDS>0</TOTAL_SECONDS>
    <LOW_ALCOHOL_WARNING>false</LOW_ALCOHOL_WARNING>
    <LOW_PARTICLE_WARNING>false</LOW_PARTICLE_WARNING>
    ${blocks}
  </FITTEST></MAIN>`;
}

function idleDoneResponse(): string {
  return fittestResponse({ status: 'IDLE', done: true });
}

describe('FitTestRunner: happy path', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('walks priming → starting → polling and resolves on DONE', async () => {
    const stub = new StubPortacount();
    stub.pollResponses = [
      // Phase 1: testing exercise 0
      fittestResponse({
        status: 'MASK_SAMPLE',
        exerciseNumber: 0,
        ambStatus: 'PASS',
        ambConc: 2500,
        maskStatus: 'TESTING',
        maskConc: 28,
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'TESTING' },
          { index: 1, name: 'Deep Breathing', status: 'NOT_STARTED' },
        ],
      }),
      // Phase 2: exercise 0 done, exercise 1 testing
      fittestResponse({
        status: 'MASK_SAMPLE',
        exerciseNumber: 1,
        ambStatus: 'PASS',
        ambConc: 2500,
        maskStatus: 'TESTING',
        maskConc: 30,
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 89 },
          { index: 1, name: 'Deep Breathing', status: 'TESTING' },
        ],
      }),
      // Phase 3: both done, overall computed, DONE=true
      fittestResponse({
        status: 'IDLE',
        done: true,
        ffOverall: 92,
        ffOverallStatus: 'PASS',
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 89 },
          { index: 1, name: 'Deep Breathing', status: 'PASS', ff: 95 },
        ],
      }),
    ];

    const completed: ExerciseResult[] = [];
    const statuses: FitTestStatus[] = [];
    let overallSeen: { ff: number | null; status: 'PASS' | 'FAIL' | undefined } | null = null;

    const runner = new FitTestRunner(stub.asPortacount(), {
      onExerciseCompleted: (r) => completed.push(r),
      onStatusUpdate: (s) => statuses.push(s),
      onOverallResult: (ff, status) => { overallSeen = { ff, status }; },
    });

    const p = runner.run({
      person: STOCK_PERSON,
      mask: STOCK_MASK,
      protocol: STOCK_PROTOCOL,
      start: STOCK_START,
      deviceModel: '8030',
    });

    // Let priming + start + first poll resolve.
    await vi.runAllTimersAsync();

    const result = await p;
    expect(result.ffOverall).toBe(92);
    expect(result.ffOverallStatus).toBe('PASS');
    expect(result.exercises.map((e) => e.status)).toEqual(['PASS', 'PASS']);
    expect(statuses.length).toBe(3);
    expect(completed.map((e) => e.name)).toEqual(['Normal Breathing', 'Deep Breathing']);
    expect(overallSeen).toEqual({ ff: 92, status: 'PASS' });

    // Command sequence: NEW_TEMP_DB → PEOPLE → RESPIRATOR → PROTOCOL → START → ALL × 3
    expect(stub.commands.filter((c) => c.includes('NEW_TEMP_DATABASE')).length).toBe(1);
    expect(stub.commands.filter((c) => c.includes('PEOPLE Command="WRITE"')).length).toBe(1);
    expect(stub.commands.filter((c) => c.includes('RESPIRATOR Command="WRITE"')).length).toBe(1);
    expect(stub.commands.filter((c) => c.includes('PROTOCOL Command="WRITE"')).length).toBe(1);
    expect(stub.commands.filter((c) => c.includes('<START/>') && c.includes('<FITTEST>')).length).toBe(1);
    expect(stub.commands.filter((c) => c.includes('<FITTEST><ALL/>')).length).toBe(3);
    // Ordering: the START write happens before the first poll.
    const startIdx = stub.commands.findIndex((c) => c.includes('<START/>'));
    const firstPollIdx = stub.commands.findIndex((c) => c.includes('<FITTEST><ALL/>'));
    expect(startIdx).toBeLessThan(firstPollIdx);
  });

  it('emits each onExerciseCompleted exactly once across the poll stream', async () => {
    const stub = new StubPortacount();
    stub.pollResponses = [
      // exercise 0 still TESTING
      fittestResponse({ status: 'RUNNING', blocks: [
        { index: 0, name: 'A', status: 'TESTING' },
      ]}),
      // exercise 0 PASS — completion event #1
      fittestResponse({ status: 'RUNNING', blocks: [
        { index: 0, name: 'A', status: 'PASS', ff: 100 },
      ]}),
      // unchanged PASS — should NOT re-emit
      fittestResponse({ status: 'RUNNING', blocks: [
        { index: 0, name: 'A', status: 'PASS', ff: 100 },
      ]}),
      fittestResponse({ status: 'IDLE', done: true, ffOverall: 100, ffOverallStatus: 'PASS', blocks: [
        { index: 0, name: 'A', status: 'PASS', ff: 100 },
      ]}),
    ];
    const completed: ExerciseResult[] = [];
    const runner = new FitTestRunner(stub.asPortacount(), {
      onExerciseCompleted: (r) => completed.push(r),
    });
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    await vi.runAllTimersAsync();
    await p;
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ index: 0, name: 'A', status: 'PASS', fitFactor: 100 });
  });

  it('preserves per-exercise PASS/FAIL even when the DONE snapshot clears INDEX blocks', async () => {
    // Real-device behavior: the 8030 transitions to IDLE / DONE and at
    // that point the FITTEST/ALL snapshot no longer carries per-exercise
    // INDEX blocks. The runner must remember the terminal per-exercise
    // states observed in earlier polls.
    const stub = new StubPortacount();
    stub.pollResponses = [
      fittestResponse({ status: 'MASK_SAMPLE', exerciseNumber: 0, blocks: [
        { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 120 },
        { index: 1, name: 'Deep Breathing', status: 'TESTING' },
      ]}),
      fittestResponse({ status: 'MASK_SAMPLE', exerciseNumber: 1, blocks: [
        { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 120 },
        { index: 1, name: 'Deep Breathing', status: 'PASS', ff: 145 },
      ]}),
      // Final poll: device drops all per-exercise data.
      fittestResponse({ status: 'IDLE', done: true, ffOverall: 131, ffOverallStatus: 'PASS' }),
    ];
    const runner = new FitTestRunner(stub.asPortacount());
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.exercises).toEqual([
      { index: 0, name: 'Normal Breathing', status: 'PASS', fitFactor: 120 },
      { index: 1, name: 'Deep Breathing', status: 'PASS', fitFactor: 145 },
    ]);
    expect(result.ffOverall).toBe(131);
  });

  it('parks just-finished exercise at COMPUTING while device computes its FF', async () => {
    // Real device behavior: after a slot's mask sample ends and
    // EXERCISE_NUMBER advances, the device keeps the just-finished
    // exercise at STATUS=IDLE for one or more polls while it computes
    // the fit factor. Without intervention the host would either keep
    // showing it as TESTING (sticky from synthesized promotion) or yo-yo
    // it back to NOT_STARTED. We park it at COMPUTING instead so the
    // UI can distinguish it from the currently-active exercise.
    const stub = new StubPortacount();
    stub.pollResponses = [
      // ex 0 actively sampling (device reports IDLE → host promotes to TESTING).
      fittestResponse({
        status: 'MASK_SAMPLE', exerciseNumber: 0,
        ambStatus: 'PASS', ambConc: 2500, maskStatus: 'TESTING', maskConc: 30,
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'NOT_STARTED' },
          { index: 1, name: 'Deep Breathing', status: 'NOT_STARTED' },
        ],
      }),
      // EXERCISE_NUMBER has moved to 1 but ex 0 still IDLE — host should
      // demote ex 0 from TESTING to COMPUTING, promote ex 1 to TESTING.
      fittestResponse({
        status: 'MASK_SAMPLE', exerciseNumber: 1,
        ambStatus: 'PASS', ambConc: 2500, maskStatus: 'TESTING', maskConc: 28,
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'NOT_STARTED' },
          { index: 1, name: 'Deep Breathing', status: 'NOT_STARTED' },
        ],
      }),
      // Device finally commits ex 0 = PASS — COMPUTING resolves to terminal.
      fittestResponse({
        status: 'MASK_SAMPLE', exerciseNumber: 1,
        ambStatus: 'PASS', ambConc: 2500, maskStatus: 'TESTING', maskConc: 28,
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 120 },
          { index: 1, name: 'Deep Breathing', status: 'NOT_STARTED' },
        ],
      }),
      fittestResponse({
        status: 'IDLE', done: true, ffOverall: 130, ffOverallStatus: 'PASS',
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 120 },
          { index: 1, name: 'Deep Breathing', status: 'PASS', ff: 145 },
        ],
      }),
    ];
    const statuses: FitTestStatus[] = [];
    const completed: ExerciseResult[] = [];
    const runner = new FitTestRunner(stub.asPortacount(), {
      onStatusUpdate: (s) => statuses.push(s),
      onExerciseCompleted: (r) => completed.push(r),
    });
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    await vi.runAllTimersAsync();
    await p;
    // Snapshot 1: ex 0 active (TESTING), ex 1 not yet started.
    expect(statuses[0].exercises[0].status).toBe('TESTING');
    expect(statuses[0].exercises[1].status).toBe('NOT_STARTED');
    // Snapshot 2: ex 0 has been parked at COMPUTING, ex 1 is now active.
    expect(statuses[1].exercises[0].status).toBe('COMPUTING');
    expect(statuses[1].exercises[1].status).toBe('TESTING');
    // Snapshot 3: ex 0 transitions COMPUTING → PASS (terminal sticks).
    expect(statuses[2].exercises[0].status).toBe('PASS');
    // Only one completion event fires per slot, on the terminal transition.
    expect(completed.map((e) => `${e.index}:${e.status}`)).toEqual(['0:PASS', '1:PASS']);
  });

  it('forwards live AMB/MASK samples to onSample only while TESTING', async () => {
    const stub = new StubPortacount();
    stub.pollResponses = [
      fittestResponse({ status: 'AMBIENT_PURGE', ambStatus: '', maskStatus: '' }),
      fittestResponse({ status: 'AMBIENT_SAMPLE', ambStatus: 'TESTING', ambConc: 2500, maskStatus: '' }),
      fittestResponse({ status: 'MASK_SAMPLE', ambStatus: 'PASS', ambConc: 2500, maskStatus: 'TESTING', maskConc: 50 }),
      fittestResponse({ status: 'IDLE', done: true }),
    ];
    const samples: Array<{ amb: number; mask: number }> = [];
    const runner = new FitTestRunner(stub.asPortacount(), {
      onSample: (s) => samples.push({ amb: s.amb, mask: s.mask }),
    });
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    await vi.runAllTimersAsync();
    await p;
    expect(samples).toEqual([
      { amb: 2500, mask: 0 },
      { amb: 2500, mask: 50 },
    ]);
  });
});

describe('FitTestRunner: failure paths', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  // Attach a catch handler immediately so the unhandled-rejection
  // detector doesn't fire during vi.runAllTimersAsync — but capture the
  // reason for later assertions.
  async function captureRejection(p: Promise<unknown>): Promise<FitTestAbortedError> {
    let captured: FitTestAbortedError | null = null;
    p.catch((e) => { captured = e as FitTestAbortedError; });
    await vi.runAllTimersAsync();
    // Now p has settled; await it to make sure the catch handler ran.
    await p.catch(() => undefined);
    if (!captured) throw new Error('expected rejection, got fulfilment');
    return captured;
  }

  it('rejects on device error during polling (ERROR set + DONE)', async () => {
    const stub = new StubPortacount();
    stub.pollResponses = [
      fittestResponse({
        status: 'IDLE',
        done: true,
        ffOverall: 5,
        ffOverallStatus: 'FAIL',
        error: 'ERROR_OVERALL_FF_UNACHIEVABLE',
        blocks: [{ index: 0, name: 'A', status: 'FAIL', ff: 5 }],
      }),
    ];
    const runner = new FitTestRunner(stub.asPortacount());
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    const err = await captureRejection(p);
    expect(err).toBeInstanceOf(FitTestAbortedError);
    expect(err.reason).toEqual({ kind: 'device-error', detail: 'ERROR_OVERALL_FF_UNACHIEVABLE' });
  });

  it('rejects with transport-error when a priming write fails', async () => {
    const stub = new StubPortacount();
    stub.rejectNextFor = { match: 'PROTOCOL Command="WRITE"', error: new Error('tcp gone') };
    const runner = new FitTestRunner(stub.asPortacount());
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    const err = await captureRejection(p);
    expect(err.reason.kind).toBe('transport-error');
  });

  it('rejects with transport-error when polling fails', async () => {
    const stub = new StubPortacount();
    stub.rejectNextFor = { match: '<FITTEST><ALL/>', error: new Error('mid-poll error') };
    const runner = new FitTestRunner(stub.asPortacount());
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    const err = await captureRejection(p);
    expect(err.reason.kind).toBe('transport-error');
  });
});

describe('FitTestRunner: abort()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('aborts mid-run with user-abort and sends STOP', async () => {
    const stub = new StubPortacount();
    stub.pollResponses = [
      fittestResponse({ status: 'RUNNING', blocks: [{ index: 0, name: 'A', status: 'TESTING' }] }),
      fittestResponse({ status: 'RUNNING', blocks: [{ index: 0, name: 'A', status: 'TESTING' }] }),
      fittestResponse({ status: 'RUNNING', blocks: [{ index: 0, name: 'A', status: 'TESTING' }] }),
      // ... runner will keep getting non-IDLE TESTING responses
    ];
    const runner = new FitTestRunner(stub.asPortacount(), {}, () => {}, {
      pollIntervalMs: 50,
      postAbortPollMs: 200,
    });
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    // Eagerly capture the rejection so the unhandled-rejection detector
    // stays quiet.
    let captured: FitTestAbortedError | null = null;
    p.catch((e) => { captured = e as FitTestAbortedError; });

    // Get into polling state by letting priming/starting complete and the
    // first poll fire.
    await vi.advanceTimersByTimeAsync(60);

    // Now abort. We don't await it inside the test alongside `p` because
    // abort awaits the runPromise too.
    const aborted = runner.abort();
    await vi.advanceTimersByTimeAsync(500);
    await aborted;

    await p.catch(() => undefined);
    expect(captured).toBeInstanceOf(FitTestAbortedError);
    expect(captured!.reason).toEqual({ kind: 'user-abort' });
    // STOP was sent at least once.
    expect(stub.commands.some((c) => c.includes('<FITTEST><STOP/>'))).toBe(true);
  });

  it('is a no-op when called from idle / completed / failed', async () => {
    const runner = new FitTestRunner(new StubPortacount().asPortacount());
    await expect(runner.abort()).resolves.toBeUndefined();
  });
});

describe('FitTestRunner: treatIdleAsDone guard', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does not finalize on an initial IDLE before any non-IDLE phase', async () => {
    // Initial IDLE shouldn't terminate the run; we need a non-IDLE first.
    const stub = new StubPortacount();
    stub.pollResponses = [
      fittestResponse({ status: 'IDLE' }),    // post-START but pre-phase
      fittestResponse({ status: 'AMBIENT_PURGE' }),
      fittestResponse({ status: 'IDLE', done: false }),
      // Now we've seen non-IDLE; the next IDLE terminates.
      fittestResponse({ status: 'IDLE', done: false }),
    ];
    const runner = new FitTestRunner(stub.asPortacount(), {}, () => {}, {
      pollIntervalMs: 10,
    });
    const p = runner.run({
      person: STOCK_PERSON, mask: STOCK_MASK, protocol: STOCK_PROTOCOL,
      start: STOCK_START, deviceModel: '8030',
    });
    await vi.runAllTimersAsync();
    const result = await p;
    expect(result.lastStatus.status).toBe('IDLE');
    // We polled at least 4 times — meaning the initial IDLE didn't end the run.
    expect(stub.commands.filter((c) => c.includes('<FITTEST><ALL/>')).length).toBeGreaterThanOrEqual(3);
  });
});
