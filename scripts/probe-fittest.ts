/**
 * Live-hardware probe for the 8030 fit-test runner.
 *
 *   USB → RNDIS → lwIP (DHCP) → Portacount.connect() → FitTestRunner.run()
 *
 * Pushes a one-exercise (Normal Breathing, 30 s) protocol, kicks off
 * FITTEST/START, and tails FITTEST/ALL polls until DONE. Hardcoded
 * person/mask so this is a one-shot diagnostic; the full UI lives in
 * `webapp/`.
 *
 * Every TCP frame that crosses the wire is captured into a pcap
 * (default `captures/probe-fittest-<timestamp>.pcap`).
 *
 * Run:  npx tsx scripts/probe-fittest.ts [--ip 169.254.207.137]
 *                                        [--pcap path.pcap]
 *                                        [--unit N]
 */

import { WebUSB } from 'usb';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RndisWireLayer } from '../src/rndis';
import { LwipStack, type IpOctets, type LwipModuleFactory } from '../src/lwip-wasm';
import { Portacount } from '../src/portacount';
import { FitTestRunner } from '../src/fit-test-runner';
import type {
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestStartOptions,
} from '../src/fit-test-types';
import { openPcapWriter } from './lib/pcap';

const DHCP_TIMEOUT_MS = 15000;
const STATIC_HOST_IP: IpOctets = [169, 254, 200, 200];

const PERSON: FitTestPerson = {
  lastName: 'Test',
  firstName: 'Probe',
  idNumber: 'probe-1',
};
const MASK: FitTestMask = {
  manufacturer: 'unknown',
  model: 'probe-mask',
  passLevel: 100,
  n95Enable: false,
};
const PROTOCOL: FitTestProtocolDef = {
  name: 'Probe (1 exercise)',
  model: '8030',
  n95Enable: false,
  ambientPurgeSec: 4,
  ambientSampleSec: 5,
  maskPurgeSec: 11,
  periodSec: 6,
  endOnExerciseFail: false,
  exercises: [
    { name: 'Normal Breathing', excluded: false, maskSampleSec: 30 },
  ],
};
const START: FitTestStartOptions = {
  maskSize: 'M',
  operator: 'probe',
  endOnOverallFFUnachievable: true,
};

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function parseIp(s: string): IpOctets {
  const parts = s.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`bad IP: ${s}`);
  }
  return parts as IpOctets;
}

function isNonZero(ip: IpOctets): boolean {
  return ip.some((b) => b !== 0);
}

function defaultPcapPath(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return resolve(process.cwd(), `captures/probe-fittest-${ts}.pcap`);
}

async function main(): Promise<void> {
  // ---- CLI ----
  let staticDeviceIp: IpOctets | null = null;
  let pcapPath = defaultPcapPath();
  let unitNumber = 1;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--ip' && i + 1 < process.argv.length) {
      staticDeviceIp = parseIp(process.argv[++i]);
    } else if (arg === '--pcap' && i + 1 < process.argv.length) {
      pcapPath = resolve(process.cwd(), process.argv[++i]);
    } else if (arg === '--unit' && i + 1 < process.argv.length) {
      unitNumber = parseInt(process.argv[++i], 10);
      if (Number.isNaN(unitNumber)) throw new Error(`bad --unit`);
    }
  }
  if (staticDeviceIp) log(`device IP override: ${staticDeviceIp.join('.')}`);
  log(`pcap → ${pcapPath}`);

  const pcap = openPcapWriter(pcapPath);
  const cleanupFns: Array<() => Promise<void> | void> = [
    async () => {
      await pcap.close();
      log(`pcap closed (${pcap.frameCount} frames) → ${pcapPath}`);
    },
  ];
  const cleanup = async () => {
    for (const fn of cleanupFns.reverse()) {
      try { await fn(); } catch (err) { log(`cleanup: ${(err as Error).message}`); }
    }
  };

  // ---- USB / RNDIS ----
  const webusb = new WebUSB({ allowAllDevices: true, deviceTimeout: 5000 });
  const devices = await webusb.getDevices();
  const device = devices.find(
    (d) =>
      d.vendorId === RndisWireLayer.USB_FILTER.vendorId &&
      d.productId === RndisWireLayer.USB_FILTER.productId,
  );
  if (!device) {
    log('Portacount not found.');
    await cleanup();
    process.exit(1);
  }

  if (typeof (device as USBDevice & { reset?: () => Promise<void> }).reset === 'function') {
    try {
      if (!device.opened) await device.open();
      await (device as USBDevice & { reset: () => Promise<void> }).reset();
      log('device reset');
    } catch (err) {
      log(`reset failed (continuing): ${(err as Error).message}`);
    }
  }

  const wire = await RndisWireLayer.open(device, { log });
  cleanupFns.push(() => wire.close());
  const ourMac = wire.macAddress;

  // ---- lwIP ----
  const factoryUrl = pathToFileURL(resolve(process.cwd(), 'build/lwip.js')).href;
  const { default: createLwipModule } = (await import(factoryUrl)) as {
    default: LwipModuleFactory;
  };
  const stack = await LwipStack.create(
    createLwipModule,
    ourMac,
    (frame) => {
      pcap.write(frame);
      wire.sendFrame(frame).catch((e) => log(`sendFrame: ${(e as Error).message}`));
    },
    {
      addressing: staticDeviceIp ? 'static' : 'dhcp',
      ip: staticDeviceIp ? STATIC_HOST_IP : undefined,
      netmask: [255, 255, 0, 0],
      onIpStatus: (ip, gateway, netmask) => {
        log(`netif: ip=${ip} gw=${gateway} mask=${netmask}`);
      },
    },
  );
  cleanupFns.push(() => stack.destroy());

  await wire.startReceiving((frame) => {
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) return;
    pcap.write(frame);
    stack.injectFrame(frame);
  });

  // ---- device IP ----
  let deviceIp: IpOctets;
  if (staticDeviceIp) {
    deviceIp = staticDeviceIp;
  } else {
    log('waiting for DHCP lease…');
    const start = Date.now();
    while (Date.now() - start < DHCP_TIMEOUT_MS) {
      const gw = stack.gateway;
      const ip = stack.ip;
      if (isNonZero(ip) && isNonZero(gw)) {
        deviceIp = gw;
        log(`DHCP complete. ip=${ip.join('.')} gateway=${gw.join('.')}`);
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!deviceIp!) {
      log(`DHCP did not complete within ${DHCP_TIMEOUT_MS}ms`);
      await cleanup();
      process.exit(2);
    }
  }

  // ---- handshake ----
  const pc = new Portacount(stack, log);
  log('connecting…');
  const info = await pc.connect(deviceIp, unitNumber);
  log(`CONNECTED. SN=${info.serialNumber} model=${info.modelNumber} build=${info.buildString}`);

  pc.startKeepAlive();
  cleanupFns.push(async () => { pc.stopKeepAlive(); await pc.disconnect(); });

  // ---- fit test ----
  log('--- fit test ---');
  const runner = new FitTestRunner(pc, {
    onStatusUpdate: (s) => {
      log(`poll status=${s.status} ex=${s.exerciseNumber} progress=${s.progressPercent}% amb=${s.ambConc}/${s.ambConcStatus} mask=${s.maskConc}/${s.maskConcStatus} secs=${s.seconds}/${s.totalSeconds} done=${s.done}${s.error ? ' err=' + s.error : ''}`);
    },
    onExerciseCompleted: (r) => {
      log(`[ex ${r.index}] ${r.name} FF=${r.fitFactor ?? 'n/a'} ${r.status}`);
    },
    onOverallResult: (ff, status) => {
      log(`OVERALL FF=${ff ?? 'n/a'} ${status}`);
    },
  }, log);

  try {
    const result = await runner.run({
      person: PERSON,
      mask: MASK,
      protocol: PROTOCOL,
      start: START,
      deviceModel: info.modelNumber,
    });
    log(`RESULT: ff=${result.ffOverall ?? 'n/a'} status=${result.ffOverallStatus} exercises=${result.exercises.length} error='${result.error}'`);
  } catch (err) {
    log(`fit test failed: ${(err as Error).message}`);
  }

  await cleanup();
  log('done.');
}

main().catch(async (err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
