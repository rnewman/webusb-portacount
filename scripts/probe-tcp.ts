/**
 * Portacount 8030 TCP port scan.
 *
 * Assumes the device IP and MAC are already known (from a prior ARP sweep,
 * see `probe-portacount.ts` and JOURNAL.md). Brings up lwIP with a static
 * 169.254.x.x address, then runs `tcp_connect` against each candidate port
 * in sequence. For each:
 *   - log connect / error / data
 *   - if connected, optionally write a probe string and wait for a banner
 *   - close and move on
 *
 * Run:  npx tsx scripts/probe-tcp.ts [output.pcap]
 */

import { WebUSB } from 'usb';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RndisWireLayer } from '../src/rndis';
import { LwipStack, type IpOctets } from '../src/lwip-wasm';
import { openPcapWriter } from './lib/pcap';

const DEVICE_IP: IpOctets = [169, 254, 207, 137];
const DEVICE_MAC = new Uint8Array([0x02, 0x30, 0x20, 0x80, 0x73, 0xe2]);
const OUR_IP: IpOctets = [169, 254, 200, 200];
const NETMASK: IpOctets = [255, 255, 0, 0];

/** Candidate ports — bias toward serial-gateway and embedded-device defaults. */
const PORTS = [
  7, 9, 13, 19,                  // echo, discard, daytime, chargen
  21, 22, 23, 25,                // ftp, ssh, telnet, smtp
  37,                            // time
  53, 67, 68, 69,                // dns, dhcp, tftp
  80, 443,                       // http, https
  110, 143,                      // pop3, imap
  502,                           // modbus
  554,                           // rtsp
  623,                           // ipmi
  1234,                          // common test
  2000, 2001,
  3000, 3001,
  4000, 4001, 4002, 4003,        // serial gateway range
  5000, 5001, 5005, 5353,        // upnp, mdns
  6000,
  7000, 7777,
  8000, 8080, 8081, 8088, 8888,  // http alt
  9100,                          // printer / raw
  10000, 10001, 10002,           // Lantronix
  11000,
  20000,
  30303,                         // some embedded
  31416,                         // boinc
  49152, 49153,                  // first ephemeral
];

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function asPrintable(buf: Uint8Array): string {
  const out: string[] = [];
  for (const b of buf) {
    if (b === 0x0a) out.push('\\n');
    else if (b === 0x0d) out.push('\\r');
    else if (b === 0x09) out.push('\\t');
    else if (b >= 0x20 && b < 0x7f) out.push(String.fromCharCode(b));
    else out.push(`\\x${b.toString(16).padStart(2, '0')}`);
  }
  return out.join('');
}

interface PortResult {
  port: number;
  outcome: 'open' | 'error' | 'timeout';
  err?: number;
  bytes: Uint8Array[];
}

async function main(): Promise<void> {
  const pcapPath = resolve(process.cwd(), process.argv[2] ?? 'captures/portacount-tcp.pcap');
  log(`pcap output: ${pcapPath}`);
  log(`target: ${DEVICE_IP.join('.')} (MAC ${[...DEVICE_MAC].map((b) => b.toString(16).padStart(2, '0')).join(':')})`);
  log(`our IP: ${OUR_IP.join('.')}`);
  log(`ports to scan: ${PORTS.length}`);

  const webusb = new WebUSB({ allowAllDevices: true, deviceTimeout: 5000 });
  const devices = await webusb.getDevices();
  const device = devices.find(
    (d) =>
      d.vendorId === RndisWireLayer.USB_FILTER.vendorId &&
      d.productId === RndisWireLayer.USB_FILTER.productId,
  );
  if (!device) {
    log('Portacount not found.');
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

  const pcap = openPcapWriter(pcapPath);
  const ourMac = wire.macAddress;

  // Per-port state, set up new before each connect.
  let current: PortResult | null = null;
  let resolveCurrent: (() => void) | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  const completePort = (outcome: PortResult['outcome'], err?: number) => {
    if (!current || !resolveCurrent) return;
    current.outcome = outcome;
    if (err !== undefined) current.err = err;
    if (connectTimer) {
      clearTimeout(connectTimer);
      connectTimer = null;
    }
    // Close the pcb now. If we don't, the next iteration's tcpConnect
    // calls tcp_abort on the stale pcb, which fires the err callback
    // synchronously with ERR_ABRT (-13) — and by then `current` already
    // points to the next port, so the error gets misattributed.
    try { stack.tcpClose(); } catch { /* may already be closed */ }
    const wasResolve = resolveCurrent;
    // Clear `current` before resolving so any late callback (from the
    // close we just initiated, or a delayed segment) becomes a no-op.
    current = null;
    resolveCurrent = null;
    wasResolve();
  };

  const stack = await LwipStack.create(
    pathToFileURL(resolve(process.cwd(), 'build/lwip.js')).href,
    wire.macAddress,
    (frame) => {
      pcap.write(frame);
      wire.sendFrame(frame).catch((e) => log(`sendFrame: ${(e as Error).message}`));
    },
    {
      ip: OUR_IP,
      netmask: NETMASK,
      onIpStatus: (ip) => log(`lwIP IP status: ${ip}`),
    },
  );

  stack.setTcpHandlers({
    onConnected: () => {
      if (!current) return;
      log(`  port ${current.port}: CONNECTED`);
      setTimeout(() => {
        if (current && current.bytes.length === 0) {
          log(`  port ${current.port}: no banner — sending "\\r\\n"`);
          try {
            stack.tcpWrite(new TextEncoder().encode('\r\n'));
          } catch (e) {
            log(`  tcpWrite: ${(e as Error).message}`);
          }
        }
      }, 800);
      setTimeout(() => {
        if (current && current.outcome === 'open') {
          stack.tcpClose();
          completePort('open');
        }
      }, 2400);
    },
    onData: (data) => {
      if (!current) return;
      current.bytes.push(new Uint8Array(data));
      log(`  port ${current.port}: RX ${data.byteLength}B: "${asPrintable(data)}"`);
    },
    onClosed: () => {
      if (!current) return;
      log(`  port ${current.port}: peer closed`);
      completePort(current.outcome === 'open' ? 'open' : 'error');
    },
    onError: (err) => {
      if (!current) return;
      log(`  port ${current.port}: TCP error code=${err}`);
      completePort('error', err);
    },
  });

  await wire.startReceiving((frame) => {
    // Skip our own loopback
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) {
      return;
    }
    pcap.write(frame);
    stack.injectFrame(frame);
  });

  // Pre-populate ARP cache by sending one ARP request for the device.
  // (lwIP will do this itself before tcp_connect, but doing it explicitly
  // gives the bulk endpoints time to settle.)
  log('waiting 1s for stack to be ready…');
  await new Promise((r) => setTimeout(r, 1000));

  const results: PortResult[] = [];
  for (const port of PORTS) {
    const portState: PortResult = { port, outcome: 'timeout', bytes: [] };
    current = portState;
    log(`scan port ${port}`);
    try {
      stack.tcpConnect(DEVICE_IP, port);
    } catch (err) {
      log(`  tcpConnect threw: ${(err as Error).message}`);
      portState.outcome = 'error';
      results.push(portState);
      current = null;
      continue;
    }
    await new Promise<void>((resolve) => {
      resolveCurrent = resolve;
      connectTimer = setTimeout(() => {
        completePort('timeout');
      }, 3500);
    });
    // completePort mutates portState by reference and clears `current`.
    results.push(portState);
  }

  log('--- SCAN SUMMARY ---');
  for (const r of results) {
    const tag = r.outcome === 'open' ? '[OPEN ]'
      : r.outcome === 'error' ? `[ERR  ] err=${r.err}`
      : '[TIMEO]';
    const dataPart = r.bytes.length
      ? ` data: "${r.bytes.map(asPrintable).join('|')}"`
      : '';
    log(`  ${tag} port ${r.port}${dataPart}`);
  }
  log(`pcap: ${pcap.frameCount} frames → ${pcapPath}`);

  stack.destroy();
  await wire.close();
  await pcap.close();
  process.exit(0);
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
