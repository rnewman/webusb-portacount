/**
 * Portacount 8030 first-light end-to-end probe.
 *
 *   USB → RNDIS → lwIP (DHCP client) → Portacount class
 *     ├─ port 3602 RSRTLSVC liveness check
 *     └─ port 3603 SYSTEM/ALL → FITPRO_STRING → LOCK READ/REMOTE → UNIT_NUMBER
 *
 * Records every frame that crosses the lwIP ↔ RNDIS boundary into a pcap
 * (default `captures/probe-handshake-<timestamp>.pcap`, override with
 * `--pcap PATH`). On every failure path we still flush the pcap and print
 * its location so the JOURNAL entry has bytes to cite.
 *
 * Optional `--ip a.b.c.d` skips DHCP and uses that as the device IP
 * directly. (We discovered the device at 169.254.207.137 via ARP sweep
 * — see JOURNAL.md. If DHCP misbehaves, this lets us isolate the TCP
 * side from the address-acquisition side.)
 *
 * Run:  npx tsx scripts/probe-handshake.ts [--ip 169.254.207.137]
 *                                          [--pcap path.pcap]
 *                                          [--keepalive-seconds N]
 */

import { WebUSB } from 'usb';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RndisWireLayer } from '../src/rndis';
import { LwipStack, type IpOctets, type LwipModuleFactory } from '../src/lwip-wasm';
import { Cmd, Portacount, parseResponse } from '../src/portacount';
import { openPcapWriter } from './lib/pcap';

const DHCP_TIMEOUT_MS = 15000;
const STATIC_HOST_IP: IpOctets = [169, 254, 200, 200];
/** Hold the session this long while keepalive fires (every 5 s). */
const DEFAULT_KEEPALIVE_HOLD_S = 12;

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
  return resolve(process.cwd(), `captures/probe-handshake-${ts}.pcap`);
}

async function main(): Promise<void> {
  // ---- CLI ----
  let staticDeviceIp: IpOctets | null = null;
  let pcapPath = defaultPcapPath();
  let keepAliveHoldS = DEFAULT_KEEPALIVE_HOLD_S;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--ip' && i + 1 < process.argv.length) {
      staticDeviceIp = parseIp(process.argv[++i]);
    } else if (arg === '--pcap' && i + 1 < process.argv.length) {
      pcapPath = resolve(process.cwd(), process.argv[++i]);
    } else if (arg === '--keepalive-seconds' && i + 1 < process.argv.length) {
      keepAliveHoldS = parseInt(process.argv[++i], 10);
      if (Number.isNaN(keepAliveHoldS) || keepAliveHoldS < 0) {
        throw new Error(`bad --keepalive-seconds: ${process.argv[i]}`);
      }
    }
  }
  if (staticDeviceIp) log(`device IP override: ${staticDeviceIp.join('.')}`);
  log(`pcap → ${pcapPath}`);

  const pcap = openPcapWriter(pcapPath);
  // Anything that needs to run before exit (pcap flush, USB close, etc.)
  // — registered as we go so any failure path still runs them.
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
  log(`RNDIS up. host MAC: ${[...ourMac].map((b) => b.toString(16).padStart(2, '0')).join(':')}`);

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
    // Skip our own loopback frames.
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) return;
    pcap.write(frame);
    stack.injectFrame(frame);
  });

  // ---- Resolve device IP ----
  let deviceIp: IpOctets;
  if (staticDeviceIp) {
    deviceIp = staticDeviceIp;
    log(`using static device IP ${deviceIp.join('.')}`);
  } else {
    log('waiting for DHCP lease from device…');
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
      log(`DHCP did not complete within ${DHCP_TIMEOUT_MS}ms (host ip=${stack.ip.join('.')})`);
      await cleanup();
      process.exit(2);
    }
  }

  // ---- Portacount probe ----
  // Trace callbacks emit a one-line summary of every XML exchange. Full
  // bytes still land in the pcap; the log stays terse and grep-friendly.
  const summarize = (xml: string): string => {
    try {
      const main = parseResponse(xml).MAIN;
      if (!main) return '(no MAIN)';
      const group = Object.keys(main)[0];
      if (!group) return '(empty)';
      const inner = (main as Record<string, unknown>)[group] as Record<string, unknown>;
      const leaf = Object.keys(inner)[0];
      const val = leaf ? inner[leaf] : undefined;
      if (typeof val === 'string' && val.length > 0 && val.length <= 32) {
        return `${group}/${leaf}=${val}`;
      }
      if (Object.keys(inner).length > 1) return `${group} (${Object.keys(inner).length} fields)`;
      return leaf ? `${group}/${leaf}` : group;
    } catch {
      return `${xml.length}B`;
    }
  };
  const pc = new Portacount(stack, log, {
    onTx: (xml) => log(`[tx] ${summarize(xml)}`),
    onRx: (xml) => log(`[rx] ${summarize(xml)}`),
  });

  log('--- port 3602 runtime probe ---');
  try {
    const rt = await pc.readRuntime(deviceIp, 5000);
    log(`runtime: ${rt}`);
  } catch (err) {
    log(`runtime probe failed: ${(err as Error).message}`);
  }

  log('--- port 3603 handshake ---');
  let info;
  try {
    info = await pc.connect(deviceIp, 1);
    log(`CONNECTED. SN=${info.serialNumber} model=${info.modelNumber} build=${info.buildString}`);
  } catch (err) {
    log(`handshake failed: ${(err as Error).message}`);
    await cleanup();
    process.exit(3);
  }

  // Quick smoke test of an actual data command.
  log('--- REALTIME/ALL one-shot ---');
  try {
    const rt = await pc.command(Cmd.realtimeAll);
    log(`REALTIME reply (${rt.length}B): ${rt.slice(0, 400)}`);
  } catch (err) {
    log(`REALTIME/ALL failed: ${(err as Error).message}`);
  }

  // Hold the session with keepalive so we capture the LOCK=KEEPALIVE
  // frames in the pcap. Two are expected (5 s cadence × ~12 s hold).
  if (keepAliveHoldS > 0) {
    log(`--- keepalive hold for ${keepAliveHoldS}s ---`);
    pc.startKeepAlive();
    await new Promise((r) => setTimeout(r, keepAliveHoldS * 1000));
    pc.stopKeepAlive();
  }

  await pc.disconnect();
  await cleanup();
  log('done.');
}

main().catch(async (err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
