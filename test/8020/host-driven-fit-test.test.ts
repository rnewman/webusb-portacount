/**
 * Host-driven fit test, exercised against the standalone simulator.
 *
 * Spins up the same `simulator/portacount-8020.ts` we use for webapp
 * development, connects via WebSocketByteStream, and drives a
 * complete fit test through the host-driven runner. Asserts that
 * valve switches, sample collection, and FF math all behave end to
 * end.
 *
 * The simulator's `currentConcentration()` returns ambient ~ 1000
 * with ±10% jitter, and mask = 5% of ambient. So we expect an FF
 * around 1/0.05 = 20.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWebSocket } from 'ws';
import { Portacount8020 } from '../../src/8020/client';
import {
  runHostDrivenFitTest,
  FitTestAbortedError8020,
  type FitTestPhaseInfo,
} from '../../src/8020/host-driven-fit-test';
import { WebSocketByteStream } from '../../src/serial/web-socket';

(globalThis as unknown as { WebSocket: typeof NodeWebSocket }).WebSocket = NodeWebSocket;

const here = path.dirname(fileURLToPath(import.meta.url));
const simPath = path.resolve(here, '../../simulator/portacount-8020.ts');
const SIM_PORT = 18031;
const SIM_URL = `ws://localhost:${SIM_PORT}`;

let sim: ChildProcess | null = null;

beforeAll(async () => {
  sim = spawn('npx', ['tsx', simPath, `--port=${SIM_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('simulator did not start')), 5000);
    sim!.stdout?.on('data', (data: Buffer) => {
      if (data.toString('utf8').includes('listening on')) {
        clearTimeout(t);
        resolve();
      }
    });
    sim!.stderr?.on('data', (d) => process.stderr.write(d));
  });
}, 10000);

afterAll(() => {
  sim?.kill('SIGTERM');
  sim = null;
});

async function connect(): Promise<Portacount8020> {
  const stream = new WebSocketByteStream({ url: SIM_URL });
  await stream.ready();
  const client = new Portacount8020();
  await client.connect(stream, {
    enableExternalControl: true,
    enableDataTransmission: true,
    requestRuntimeStatus: false,
    requestSettings: false,
  });
  return client;
}

describe('runHostDrivenFitTest', () => {
  it('runs a one-exercise test and returns a passable FF (sim default seal)', async () => {
    const client = await connect();
    try {
      // Quick timing so the test completes in a few seconds. The
      // simulator emits a count per second, so 2s of sampling
      // produces ~2 samples per phase.
      const phases: FitTestPhaseInfo[] = [];
      const result = await runHostDrivenFitTest(
        client,
        {
          exercises: 1,
          ambientPurgeSec: 1,
          ambientSampleSec: 3,
          maskPurgeSec: 1,
          maskSampleSec: 3,
          passLevel: 10,
        },
        {
          onPhaseStart: (info) => phases.push(info),
        },
      );

      expect(result.deviceModel).toBe('8020');
      expect(result.passLevel).toBe(10);
      expect(result.exercises).toHaveLength(1);
      expect(result.terminalReason).toBe('complete');

      // Simulator: ambient ≈ 1000, mask ≈ 50 → FF ≈ 20. Allow wide
      // tolerance since the simulator jitters ±10% on each tick.
      const ex = result.exercises[0]!;
      expect(ex.fitFactor).toBeGreaterThan(8);
      expect(ex.fitFactor).toBeLessThan(60);
      expect(ex.result).toBe('PASS');

      // Phase sequence is: ambient-purge, ambient-sample, mask-purge,
      // mask-sample.
      expect(phases.map((p) => p.phase)).toEqual([
        'ambient-purge',
        'ambient-sample',
        'mask-purge',
        'mask-sample',
      ]);

      expect(result.overallFitFactor).toBeGreaterThan(0);
      expect(result.overallResult).toBe('PASS');
    } finally {
      await client.disconnect();
    }
  }, 30000);

  it('aborts mid-flight via AbortSignal', async () => {
    const client = await connect();
    try {
      const ac = new AbortController();
      // Abort after 500 ms — well into the first phase.
      setTimeout(() => ac.abort(new Error('test-abort')), 500);
      await expect(
        runHostDrivenFitTest(client, {
          exercises: 1,
          ambientPurgeSec: 2,
          ambientSampleSec: 5,
          maskPurgeSec: 2,
          maskSampleSec: 5,
          passLevel: 100,
          signal: ac.signal,
        }),
      ).rejects.toBeInstanceOf(FitTestAbortedError8020);
    } finally {
      await client.disconnect();
    }
  }, 15000);

  it('handles multiple exercises and computes harmonic-mean overall', async () => {
    const client = await connect();
    try {
      const result = await runHostDrivenFitTest(client, {
        exercises: 2,
        ambientPurgeSec: 1,
        ambientSampleSec: 2,
        maskPurgeSec: 1,
        maskSampleSec: 2,
        passLevel: 10,
      });
      expect(result.exercises).toHaveLength(2);
      expect(result.overallFitFactor).not.toBeNull();
      expect(result.overallFitFactor!).toBeGreaterThan(0);
    } finally {
      await client.disconnect();
    }
  }, 30000);
});
