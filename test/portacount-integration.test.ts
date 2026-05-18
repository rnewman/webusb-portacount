/**
 * End-to-end integration tests for Portacount against a fake device, both
 * stacks driven by real lwIP through an in-process VirtualWire. No USB,
 * no fake timers — bytes traverse the same TCP/IP path they would
 * against the real 8030.
 *
 * Stack A: host (where Portacount the client runs)
 * Stack B: device (where FakePortacount the server runs)
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LwipStack, type IpOctets, type LwipModuleFactory } from '../src/lwip-wasm';
import { VirtualWire } from '../src/virtual-wire';
import { Cmd, Portacount } from '../src/portacount';
import { DEFAULT_FIXTURE, FakePortacount, type DeviceFixture } from './fake-portacount';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmJsUrl = pathToFileURL(path.resolve(__dirname, '../build/lwip.js')).href;
const { default: createLwipModule } = (await import(wasmJsUrl)) as { default: LwipModuleFactory };

const HOST_MAC = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
const DEVICE_MAC = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x02]);
const HOST_IP: IpOctets = [169, 254, 200, 200];
const DEVICE_IP: IpOctets = [169, 254, 207, 137];
const NETMASK: IpOctets = [255, 255, 0, 0];

async function setupWiredStacks(fixture: DeviceFixture = DEFAULT_FIXTURE) {
  const wire = new VirtualWire();
  const deviceStack = await LwipStack.create(
    createLwipModule, DEVICE_MAC, wire.handleFrameFromB,
    { ip: DEVICE_IP, netmask: NETMASK },
  );
  wire.setStackB(deviceStack);
  const fake = new FakePortacount(deviceStack, fixture);

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
  return { wire, hostStack, deviceStack, fake, pc, cleanup };
}

describe('Portacount + FakePortacount over VirtualWire', { timeout: 20000 }, () => {
  it('runtime probe on port 3602 returns the fixture value', async () => {
    const { pc, cleanup } = await setupWiredStacks({
      ...DEFAULT_FIXTURE, runtimeSeconds: 99999,
    });
    try {
      expect(await pc.readRuntime(DEVICE_IP, 10000)).toBe(99999);
    } finally {
      cleanup();
    }
  });

  it('walks the full connect handshake (LOCK starts UNLOCK)', async () => {
    const { pc, fake, cleanup } = await setupWiredStacks({
      ...DEFAULT_FIXTURE,
      serialNumber: '00023550',
      modelNumber: '8030',
      buildString: '3.0.0',
    });
    try {
      const info = await pc.connect(DEVICE_IP, 1);
      expect(info).toEqual({
        serialNumber: '00023550',
        modelNumber: '8030',
        buildString: '3.0.0',
      });
      // The device should now be locked REMOTE.
      // (Internal state — assertable via fake.)
      expect(fake.received).toContainEqual('<MAIN><SYSTEM><LOCK COMMAND="WRITE">REMOTE</LOCK></SYSTEM></MAIN>');
      expect(fake.received).toContainEqual(Cmd.systemAll);
      expect(fake.received).toContainEqual(Cmd.fitProString('2.0.0.0'));
      expect(fake.received).toContainEqual(Cmd.unitNumberWrite(1));
      await pc.disconnect();
    } finally {
      cleanup();
    }
  });

  it('skips LOCK WRITE if the device already reports REMOTE', async () => {
    const { pc, fake, cleanup } = await setupWiredStacks();
    fake.setLockState('REMOTE');
    try {
      await pc.connect(DEVICE_IP, 1);
      // Sequence: SYSTEM/ALL, FITPRO_STRING, LOCK READ, UNIT_NUMBER. No LOCK WRITE.
      expect(fake.received).not.toContainEqual(Cmd.lockWriteRemote);
      expect(fake.received).toContainEqual(Cmd.lockRead);
      expect(fake.received).toContainEqual(Cmd.unitNumberWrite(1));
      await pc.disconnect();
    } finally {
      cleanup();
    }
  });

  it('REALTIME/ALL round-trips a full sample response', async () => {
    const { pc, cleanup } = await setupWiredStacks({
      ...DEFAULT_FIXTURE,
      realtime: {
        ambConc: 1234,
        maskConc: 12,
        fitFactor: 200,
        message: 'sampling',
        status: 'RUN',
        n95Enable: false,
        countMode: 'N99',
      },
    });
    try {
      await pc.connect(DEVICE_IP, 1);
      const reply = await pc.command(Cmd.realtimeAll);
      expect(reply).toContain('<AMB_CONC>1234</AMB_CONC>');
      expect(reply).toContain('<MASK_CONC>12</MASK_CONC>');
      expect(reply).toContain('<FITFACTOR>200</FITFACTOR>');
      expect(reply).toContain('<STATUS>RUN</STATUS>');
      expect(reply).toContain('<COUNT_MODE>N99</COUNT_MODE>');
      await pc.disconnect();
    } finally {
      cleanup();
    }
  });

  it('disconnect() sends LOCK=UNLOCK and closes', async () => {
    const { pc, fake, cleanup } = await setupWiredStacks();
    try {
      await pc.connect(DEVICE_IP, 1);
      await pc.disconnect();
      expect(fake.received).toContainEqual(Cmd.lockWriteUnlock);
    } finally {
      cleanup();
    }
  });
});
