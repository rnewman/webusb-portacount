import { describe, expect, it } from 'vitest';
import { FitTestRunner8020, type FitTestResult8020 } from '../../src/8020/fit-test-runner';
import { Portacount8020 } from '../../src/8020/client';
import type { ByteStream } from '../../src/byte-stream';

class FakeStream implements ByteStream {
  private cb: ((c: Uint8Array) => void) | null = null;
  readonly writes: Uint8Array[] = [];
  readonly info = { label: 'fake' };

  async write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes);
  }
  onData(cb: ((c: Uint8Array) => void) | null): void {
    this.cb = cb;
  }
  async close(): Promise<void> {
    this.cb = null;
  }

  // Test helper: shove device-side bytes at the client.
  send(s: string): void {
    if (this.cb) this.cb(new TextEncoder().encode(s));
  }
}

async function connectedClient(): Promise<{ client: Portacount8020; stream: FakeStream }> {
  const stream = new FakeStream();
  const client = new Portacount8020();
  // Skip sync sequence — we're testing the observer, not the connect flow.
  await client.connect(stream, {
    requestRuntimeStatus: false,
    requestSettings: false,
  });
  return { client, stream };
}

describe('FitTestRunner8020', () => {
  it('assembles a complete result from a normal test sequence', async () => {
    const { client, stream } = await connectedClient();
    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('Ambient   2290 #/cc\r');
    stream.send('Mask    5.62 #/cc\r');
    stream.send('FF  1    352 PASS\r');
    stream.send('Ambient   2210 #/cc\r');
    stream.send('Mask    8.4 #/cc\r');
    stream.send('FF  2    263 PASS\r');
    stream.send('Overall FF    308 PASS\r');

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.deviceModel).toBe('8020');
    expect(r.passLevel).toBe(100);
    expect(r.terminalReason).toBe('complete');
    expect(r.overallFitFactor).toBe(308);
    expect(r.overallResult).toBe('PASS');
    expect(r.exercises).toEqual([
      { exerciseNumber: 1, fitFactor: 352, result: 'PASS' },
      { exerciseNumber: 2, fitFactor: 263, result: 'PASS' },
    ]);
    expect(r.startedAt).toBeGreaterThan(0);
    expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt!);
  });

  it('finalizes on Test Terminated', async () => {
    const { client, stream } = await connectedClient();
    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('FF  1    50 FAIL\r');
    stream.send('Test Terminated\r');

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.terminalReason).toBe('terminated');
    expect(r.overallFitFactor).toBeNull();
    expect(r.overallResult).toBeNull();
    expect(r.exercises).toEqual([{ exerciseNumber: 1, fitFactor: 50, result: 'FAIL' }]);
  });

  it('fires per-exercise completed callbacks', async () => {
    const { client, stream } = await connectedClient();
    const done: number[] = [];
    const runner = new FitTestRunner8020(client, {
      onExerciseCompleted: (r) => done.push(r.exerciseNumber),
    });
    runner.start();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('FF  1    100 PASS\r');
    stream.send('FF  2    200 PASS\r');
    stream.send('Overall FF    150 PASS\r');

    expect(done).toEqual([1, 2]);
  });

  it('emits ambient/mask samples', async () => {
    const { client, stream } = await connectedClient();
    const samples: Array<{ ambient: number | null; mask: number | null }> = [];
    const runner = new FitTestRunner8020(client, {
      onSample: (s) => samples.push({ ambient: s.ambient, mask: s.mask }),
    });
    runner.start();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('Ambient   2290 #/cc\r');
    stream.send('Mask    5.62 #/cc\r');

    expect(samples).toEqual([
      { ambient: 2290, mask: null },
      { ambient: 2290, mask: 5.62 },
    ]);
  });

  it('resets progress between tests', async () => {
    const { client, stream } = await connectedClient();
    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('FF  1    100 PASS\r');
    stream.send('Overall FF    100 PASS\r');

    stream.send('NEW TEST PASS =  200\r');
    stream.send('FF  1    50 FAIL\r');
    stream.send('Test Terminated\r');

    expect(results).toHaveLength(2);
    expect(results[0]!.passLevel).toBe(100);
    expect(results[0]!.exercises).toHaveLength(1);
    expect(results[1]!.passLevel).toBe(200);
    expect(results[1]!.exercises).toHaveLength(1);
    expect(results[1]!.terminalReason).toBe('terminated');
  });

  it('stop() detaches the listener', async () => {
    const { client, stream } = await connectedClient();
    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();
    runner.stop();

    stream.send('NEW TEST PASS =  100\r');
    stream.send('Overall FF    150 PASS\r');

    expect(results).toEqual([]);
  });

  it('handles Test Terminated with no preceding NEW TEST PASS', async () => {
    const { client, stream } = await connectedClient();
    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();

    stream.send('Test Terminated\r');

    expect(results).toHaveLength(1);
    expect(results[0]!.terminalReason).toBe('terminated');
    expect(results[0]!.passLevel).toBeNull();
    expect(results[0]!.exercises).toEqual([]);
  });

  it('passes Low Particle Count warning through', async () => {
    const { client, stream } = await connectedClient();
    let warnings = 0;
    const runner = new FitTestRunner8020(client, {
      onLowParticleWarning: () => warnings++,
    });
    runner.start();

    stream.send('970/cc Low Particle Count\r');
    expect(warnings).toBe(1);
  });
});
