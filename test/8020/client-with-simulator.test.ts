/**
 * Integration test: spin up the standalone 8020 simulator, connect a
 * Portacount8020 client via a Node-side WebSocket-backed ByteStream,
 * and exercise the full data path end-to-end.
 *
 * This is the same code path the webapp uses against the simulator —
 * minus the browser's WebSocket binding (we ship a tiny shim that
 * wraps the `ws` package as the global WebSocket class for the
 * duration of this test).
 */

import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket as NodeWebSocket } from 'ws';
import { Portacount8020 } from '../../src/8020/client';
import { FitTestRunner8020, type FitTestResult8020 } from '../../src/8020/fit-test-runner';
import { WebSocketByteStream } from '../../src/serial/web-socket';

// Shim the Node `ws` class onto global so WebSocketByteStream can use
// the same `new WebSocket(url)` API it would in the browser.
(globalThis as unknown as { WebSocket: typeof NodeWebSocket }).WebSocket = NodeWebSocket;

const here = path.dirname(fileURLToPath(import.meta.url));
const simPath = path.resolve(here, '../../simulator/portacount-8020.ts');

const SIM_PORT = 18029;
const SIM_URL = `ws://localhost:${SIM_PORT}`;

let sim: ChildProcess | null = null;

beforeAll(async () => {
  sim = spawn('npx', ['tsx', simPath, `--port=${SIM_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Wait for the simulator to announce it's listening.
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('simulator did not start in 5s')), 5000);
    const onLine = (data: Buffer) => {
      const s = data.toString('utf8');
      if (s.includes('listening on')) {
        clearTimeout(t);
        resolve();
      }
    };
    sim!.stdout?.on('data', onLine);
    sim!.stderr?.on('data', (d) => process.stderr.write(d));
    sim!.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(t);
        reject(new Error(`simulator exited early with code ${code}`));
      }
    });
  });
}, 10000);

afterAll(() => {
  if (sim) {
    sim.kill('SIGTERM');
    sim = null;
  }
});

describe('Portacount8020 against standalone simulator', () => {
  it('connects, syncs settings + runtime, and reduces state', async () => {
    const stream = new WebSocketByteStream({ url: SIM_URL });
    await stream.ready();
    const client = new Portacount8020();
    await client.connect(stream, {
      enableExternalControl: true,
      enableDataTransmission: false,
      requestRuntimeStatus: true,
      requestSettings: true,
    });

    // Give the simulator a beat to flush its settings burst.
    await new Promise((r) => setTimeout(r, 200));

    const snap = client.snapshot;
    expect(snap.controlSource).toBe('external');
    expect(snap.runtime?.battery).toBe('G');
    expect(snap.runtime?.pulse).toBe('G');
    expect(snap.settings.serialNumber).toBe('17754');
    expect(snap.settings.ambientPurgeSec).toBe(4);
    expect(snap.settings.maskSampleSec[1]).toBe(40);
    expect(snap.settings.ffPassLevel[1]).toBe(100);

    await client.disconnect();
  }, 10000);

  it('captures the boot banner into identity', async () => {
    const stream = new WebSocketByteStream({ url: SIM_URL });
    await stream.ready();
    const client = new Portacount8020();
    // Connect without any sync commands so the only inbound traffic
    // is the simulator's boot banner.
    await client.connect(stream, {
      enableExternalControl: false,
      enableDataTransmission: false,
      requestRuntimeStatus: false,
      requestSettings: false,
    });
    // Banner arrives within one event-loop turn of socket open.
    await new Promise((r) => setTimeout(r, 200));

    const id = client.identity;
    expect(id.complete).toBe(true);
    expect(id.firmwareVersion).toBe('V1.7');
    expect(id.copyrightYear).toBe(1992);
    expect(id.serialNumber).toBe('17754');
    expect(id.ffPassLevel).toBe(100);
    expect(id.exerciseCount).toBe(4);
    expect(id.ambientPurgeSec).toBe(4);
    expect(id.ambientSampleSec).toBe(5);
    expect(id.maskPurgeSec).toBe(11);
    expect(id.maskSampleSec).toEqual({ 1: 40, 2: 40, 3: 40, 4: 40 });
    expect(id.dipSwitch).toBe('10111111');

    await client.disconnect();
  }, 10000);

  it('runs a simulator-triggered fit test through the runner', async () => {
    const stream = new WebSocketByteStream({ url: SIM_URL });
    await stream.ready();
    const client = new Portacount8020();
    await client.connect(stream, {
      enableExternalControl: false,
      enableDataTransmission: false,
      requestRuntimeStatus: false,
      requestSettings: false,
    });

    const results: FitTestResult8020[] = [];
    const runner = new FitTestRunner8020(client, {
      onResult: (r) => results.push(r),
    });
    runner.start();

    // Trigger the canned simulator fit-test sequence. The simulator's
    // ack is the first emitted "NEW TEST PASS = ..." line.
    await client.command('SIM_RUN_FITTEST', {
      ackPattern: /^NEW TEST PASS/,
      timeoutMs: 5000,
    });

    // 4 exercises × ~11 lines × 150 ms ≈ 7 s; allow headroom.
    await waitFor(() => results.length > 0, 12000);

    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.deviceModel).toBe('8020');
    expect(r.passLevel).toBe(100);
    expect(r.terminalReason).toBe('complete');
    expect(r.exercises).toHaveLength(4);
    expect(r.overallFitFactor).not.toBeNull();
    expect(r.overallFitFactor).toBeGreaterThan(0);

    runner.stop();
    await client.disconnect();
  }, 20000);
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
