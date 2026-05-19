/**
 * End-to-end integration tests for FitTestRunner against FakePortacount,
 * both stacks driven by real lwIP through an in-process VirtualWire. No
 * USB, no fake timers — bytes traverse the same TCP/IP path they would
 * against the real 8030.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LwipStack, type IpOctets, type LwipModuleFactory } from '../src/lwip-wasm';
import { VirtualWire } from '../src/virtual-wire';
import { Portacount } from '../src/portacount';
import { FitTestRunner } from '../src/fit-test-runner';
import type {
  ExerciseResult,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestStartOptions,
} from '../src/fit-test-types';
import { DEFAULT_FIXTURE, FakePortacount } from './fake-portacount';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmJsUrl = pathToFileURL(path.resolve(__dirname, '../build/lwip.js')).href;
const { default: createLwipModule } = (await import(wasmJsUrl)) as { default: LwipModuleFactory };

const HOST_MAC = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
const DEVICE_MAC = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x02]);
const HOST_IP: IpOctets = [169, 254, 200, 200];
const DEVICE_IP: IpOctets = [169, 254, 207, 137];
const NETMASK: IpOctets = [255, 255, 0, 0];

async function setupWiredStacks() {
  const wire = new VirtualWire();
  const deviceStack = await LwipStack.create(
    createLwipModule, DEVICE_MAC, wire.handleFrameFromB,
    { ip: DEVICE_IP, netmask: NETMASK },
  );
  wire.setStackB(deviceStack);
  const fake = new FakePortacount(deviceStack);

  const hostStack = await LwipStack.create(
    createLwipModule, HOST_MAC, wire.handleFrameFromA,
    { ip: HOST_IP, netmask: NETMASK },
  );
  wire.setStackA(hostStack);
  const pc = new Portacount(hostStack);

  const cleanup = () => {
    hostStack.destroy();
    deviceStack.destroy();
  };
  return { pc, fake, cleanup };
}

const PERSON: FitTestPerson = { lastName: 'Doe', firstName: 'John', idNumber: '42' };
const MASK: FitTestMask = { manufacturer: '3M', model: '8511', passLevel: 100, n95Enable: true };
const PROTOCOL: FitTestProtocolDef = {
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
const START: FitTestStartOptions = {
  maskSize: 'M',
  operator: 'rnewman',
  endOnOverallFFUnachievable: true,
};

function fittestXml(opts: {
  status: string;
  done?: boolean;
  ffOverall?: number;
  ffOverallStatus?: 'PASS' | 'FAIL' | '';
  error?: string;
  blocks?: Array<{ index: number; name: string; status: string; ff?: number }>;
}): string {
  const blocks = (opts.blocks ?? [])
    .map((b) =>
      `<INDEX>${b.index}</INDEX><NAME>${b.name}</NAME><FITFACTOR>${b.ff ?? ''}</FITFACTOR><STATUS>${b.status}</STATUS><EXCLUDE>false</EXCLUDE>`,
    )
    .join('');
  return [
    '<MAIN><FITTEST>',
    '<NEWDATA>true</NEWDATA>',
    `<STATUS>${opts.status}</STATUS>`,
    `<DONE>${opts.done ? 'true' : 'false'}</DONE>`,
    `<ERROR>${opts.error ?? ''}</ERROR>`,
    `<FF_OVERALL>${opts.ffOverall ?? ''}</FF_OVERALL>`,
    `<FF_OVERALL_STATUS>${opts.ffOverallStatus ?? ''}</FF_OVERALL_STATUS>`,
    '<AMB_CONC>2500</AMB_CONC><AMB_CONC_STATUS>PASS</AMB_CONC_STATUS>',
    '<MASK_CONC>30</MASK_CONC><MASK_CONC_STATUS>TESTING</MASK_CONC_STATUS>',
    blocks,
    '</FITTEST></MAIN>',
  ].join('');
}

describe('FitTestRunner over lwIP + FakePortacount', { timeout: 20000 }, () => {
  it('end-to-end fit test resolves with the device-reported overall FF', async () => {
    const { pc, fake, cleanup } = await setupWiredStacks();
    fake.scriptFitTest([
      fittestXml({
        status: 'MASK_SAMPLE',
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'TESTING' },
          { index: 1, name: 'Deep Breathing', status: 'NOT_STARTED' },
        ],
      }),
      fittestXml({
        status: 'MASK_SAMPLE',
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 105 },
          { index: 1, name: 'Deep Breathing', status: 'TESTING' },
        ],
      }),
      fittestXml({
        status: 'IDLE',
        done: true,
        ffOverall: 110,
        ffOverallStatus: 'PASS',
        blocks: [
          { index: 0, name: 'Normal Breathing', status: 'PASS', ff: 105 },
          { index: 1, name: 'Deep Breathing', status: 'PASS', ff: 115 },
        ],
      }),
    ]);
    try {
      await pc.connect(DEVICE_IP, 1);
      const completed: ExerciseResult[] = [];
      const runner = new FitTestRunner(pc, {
        onExerciseCompleted: (r) => completed.push(r),
      }, () => {}, {
        pollIntervalMs: 50,    // fast cadence keeps tests snappy
        pollTimeoutMs: 5000,
      });
      const result = await runner.run({
        person: PERSON, mask: MASK, protocol: PROTOCOL,
        start: START, deviceModel: '8030',
      });

      expect(result.ffOverall).toBe(110);
      expect(result.ffOverallStatus).toBe('PASS');
      expect(result.exercises.map((e) => e.name)).toEqual(['Normal Breathing', 'Deep Breathing']);
      expect(completed.map((e) => e.status)).toEqual(['PASS', 'PASS']);

      // Verify the device received the full write sequence.
      const received = fake.received;
      expect(received.some((c) => c.includes('NEW_TEMP_DATABASE'))).toBe(true);
      expect(received.some((c) => c.includes('PEOPLE Command="WRITE"'))).toBe(true);
      expect(received.some((c) => c.includes('RESPIRATOR Command="WRITE"'))).toBe(true);
      expect(received.some((c) => c.includes('PROTOCOL Command="WRITE"'))).toBe(true);
      expect(received.some((c) => c.includes('<START/>') && c.includes('<FITTEST>'))).toBe(true);

      await pc.disconnect();
    } finally {
      cleanup();
    }
  });

  it('device-reported error terminates the run and rejects with device-error', async () => {
    const { pc, fake, cleanup } = await setupWiredStacks();
    fake.scriptFitTest([
      fittestXml({ status: 'MASK_SAMPLE', blocks: [{ index: 0, name: 'A', status: 'TESTING' }] }),
      fittestXml({
        status: 'IDLE',
        done: true,
        ffOverall: 4,
        ffOverallStatus: 'FAIL',
        error: 'ERROR_OVERALL_FF_UNACHIEVABLE',
        blocks: [{ index: 0, name: 'A', status: 'FAIL', ff: 4 }],
      }),
    ]);
    try {
      await pc.connect(DEVICE_IP, 1);
      const runner = new FitTestRunner(pc, {}, () => {}, { pollIntervalMs: 50 });
      const p = runner.run({
        person: PERSON, mask: MASK, protocol: PROTOCOL,
        start: START, deviceModel: '8030',
      });
      let captured: unknown = null;
      p.catch((e) => { captured = e; });
      await p.catch(() => undefined);
      expect((captured as { reason?: { kind: string; detail?: string } }).reason).toEqual({
        kind: 'device-error',
        detail: 'ERROR_OVERALL_FF_UNACHIEVABLE',
      });
      await pc.disconnect();
    } finally {
      cleanup();
    }
  });
});
