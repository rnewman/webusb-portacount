/**
 * Portacount 8030 RNDIS probe.
 *
 * Uses node-usb's WebUSB shim so the same code path runs unchanged in a
 * browser. Opens the device, runs the RNDIS handshake, then dumps every
 * Ethernet frame the device emits to stdout (hex preview) and to a pcap
 * file for Wireshark.
 *
 * Run:    npx tsx scripts/probe-portacount.ts [output.pcap]
 * Stop:   Ctrl+C
 */

import { WebUSB, usb } from 'usb';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RndisWireLayer } from '../src/rndis';
import { LwipStack } from '../src/lwip-wasm';

const PCAP_LINKTYPE_ETHERNET = 1;
const SNAPLEN = 65535;

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function openPcap(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);     // magic
  header.writeUInt16LE(2, 4);              // version_major
  header.writeUInt16LE(4, 6);              // version_minor
  header.writeInt32LE(0, 8);               // thiszone
  header.writeUInt32LE(0, 12);             // sigfigs
  header.writeUInt32LE(SNAPLEN, 16);       // snaplen
  header.writeUInt32LE(PCAP_LINKTYPE_ETHERNET, 20);
  stream.write(header);
  return stream;
}

function pcapWriteFrame(stream: WriteStream, frame: Uint8Array): void {
  const now = Date.now();
  const ts_sec = Math.floor(now / 1000);
  const ts_usec = (now % 1000) * 1000;
  const len = Math.min(frame.byteLength, SNAPLEN);
  const rec = Buffer.alloc(16 + len);
  rec.writeUInt32LE(ts_sec, 0);
  rec.writeUInt32LE(ts_usec, 4);
  rec.writeUInt32LE(len, 8);
  rec.writeUInt32LE(frame.byteLength, 12);
  Buffer.from(frame.buffer, frame.byteOffset, len).copy(rec, 16);
  stream.write(rec);
}

function hexPreview(buf: Uint8Array, limit = 32): string {
  const slice = buf.subarray(0, limit);
  const hex = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return slice.byteLength < buf.byteLength ? `${hex} … (${buf.byteLength}B)` : hex;
}

function describeEthernet(frame: Uint8Array): string {
  if (frame.byteLength < 14) return `runt (${frame.byteLength}B)`;
  const dst = [...frame.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const src = [...frame.subarray(6, 12)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const etype = (frame[12] << 8) | frame[13];
  let proto = `etype=0x${etype.toString(16).padStart(4, '0')}`;
  if (etype === 0x0806) proto = 'ARP';
  else if (etype === 0x0800) proto = describeIpv4(frame.subarray(14));
  else if (etype === 0x86dd) proto = 'IPv6';
  return `${src} → ${dst}  ${proto}  len=${frame.byteLength}`;
}

/** Build an Ethernet broadcast ARP "who has targetIp tell senderIp from senderMac". */
function buildArpRequest(
  senderMac: Uint8Array,
  senderIp: [number, number, number, number],
  targetIp: [number, number, number, number],
): Uint8Array {
  const frame = new Uint8Array(42);
  // Ethernet
  frame.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0); // dst broadcast
  frame.set(senderMac, 6);                            // src
  frame[12] = 0x08; frame[13] = 0x06;                 // ethertype ARP
  // ARP
  frame[14] = 0x00; frame[15] = 0x01;                 // htype Ethernet
  frame[16] = 0x08; frame[17] = 0x00;                 // ptype IPv4
  frame[18] = 6;                                       // hlen
  frame[19] = 4;                                       // plen
  frame[20] = 0x00; frame[21] = 0x01;                 // op REQUEST
  frame.set(senderMac, 22);                            // sender HA
  frame.set(senderIp, 28);                             // sender PA
  // target HA is 0 (already)
  frame.set(targetIp, 38);                             // target PA
  return frame;
}

function describeIpv4(ip: Uint8Array): string {
  if (ip.byteLength < 20) return 'IPv4 runt';
  const proto = ip[9];
  const src = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
  const dst = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
  const ihl = (ip[0] & 0x0f) * 4;
  let suffix = '';
  if (proto === 6 && ip.byteLength >= ihl + 20) {
    const sport = (ip[ihl] << 8) | ip[ihl + 1];
    const dport = (ip[ihl + 2] << 8) | ip[ihl + 3];
    const flags = ip[ihl + 13];
    const flagStr = [
      flags & 0x02 ? 'SYN' : '',
      flags & 0x10 ? 'ACK' : '',
      flags & 0x01 ? 'FIN' : '',
      flags & 0x04 ? 'RST' : '',
      flags & 0x08 ? 'PSH' : '',
    ].filter(Boolean).join(',');
    suffix = ` TCP ${sport}→${dport}${flagStr ? ` [${flagStr}]` : ''}`;
  } else if (proto === 17 && ip.byteLength >= ihl + 8) {
    const sport = (ip[ihl] << 8) | ip[ihl + 1];
    const dport = (ip[ihl + 2] << 8) | ip[ihl + 3];
    suffix = ` UDP ${sport}→${dport}`;
  } else if (proto === 1) {
    suffix = ' ICMP';
  } else {
    suffix = ` proto=${proto}`;
  }
  return `IPv4 ${src} → ${dst}${suffix}`;
}

async function main() {
  const pcapPath = resolve(process.cwd(), process.argv[2] ?? 'captures/portacount.pcap');
  log(`pcap output: ${pcapPath}`);

  if (process.env.LIBUSB_DEBUG) {
    usb.setDebugLevel(parseInt(process.env.LIBUSB_DEBUG, 10));
  }

  const webusb = new WebUSB({
    allowAllDevices: true,
    deviceTimeout: 5000,
  });

  const devices = await webusb.getDevices();
  log(`webusb sees ${devices.length} device(s)`);

  const device = devices.find(
    (d) =>
      d.vendorId === RndisWireLayer.USB_FILTER.vendorId &&
      d.productId === RndisWireLayer.USB_FILTER.productId,
  );
  if (!device) {
    log('Portacount 8030 not found. Ensure the unit is powered on and the USB cable is a data cable.');
    log(`Looking for vendorId=0x${RndisWireLayer.USB_FILTER.vendorId!.toString(16)} ` +
        `productId=0x${RndisWireLayer.USB_FILTER.productId!.toString(16)}`);
    log(`Available: ${devices.map((d) => `0x${d.vendorId.toString(16)}/0x${d.productId.toString(16)}`).join(', ') || '(none)'}`);
    process.exit(1);
  }
  log(`found device: ${device.manufacturerName} / ${device.productName} (serial=${device.serialNumber})`);

  // Reset the device to clear any state left over from a prior aborted run.
  // node-usb's WebUSBDevice exposes reset() (not part of W3C WebUSB but harmless if missing).
  if (typeof (device as USBDevice & { reset?: () => Promise<void> }).reset === 'function') {
    try {
      if (!device.opened) await device.open();
      await (device as USBDevice & { reset: () => Promise<void> }).reset();
      log('device reset');
    } catch (err) {
      log(`device reset failed (continuing): ${(err as Error).message}`);
    }
  }

  const wire = await RndisWireLayer.open(device, { log });
  log(`info: ${JSON.stringify(wire.info, (_, v) => (v instanceof Uint8Array ? Array.from(v) : v))}`);

  const pcap = openPcap(pcapPath);
  let rxCount = 0;
  let txCount = 0;

  // ---- Bring up lwIP on the same wire ----
  // AutoIP (ip=[0,0,0,0]) will probe for a 169.254.x.x address, then announce
  // it via gratuitous ARP. That's the simplest way to get the device to reply:
  // it'll see broadcast ARPs and (if our random IP collides with its own) it'll
  // ARP-reply, revealing its MAC and IP.
  const wasmUrl = pathToFileURL(resolve(process.cwd(), 'build/lwip.js')).href;
  log(`loading lwIP from ${wasmUrl}`);
  const stack = await LwipStack.create(
    wasmUrl,
    wire.macAddress,
    (frame) => {
      txCount++;
      pcapWriteFrame(pcap, frame);
      log(`TX #${txCount}: ${describeEthernet(frame)}`);
      wire.sendFrame(frame).catch((err) => log(`sendFrame error: ${(err as Error).message}`));
    },
    {
      ip: [0, 0, 0, 0],          // AutoIP
      netmask: [255, 255, 0, 0], // 169.254/16
      onIpStatus: (ip) => log(`lwIP IP status: ${ip}`),
    },
  );
  log('lwIP ready');

  let loopCount = 0;
  const ourMac = wire.macAddress;
  const foreignFrames: Array<{ src: string; ip?: string; frame: Uint8Array }> = [];
  await wire.startReceiving((frame) => {
    // Some RNDIS implementations (apparently including the Portacount) echo
    // every transmitted frame on the bulk-IN endpoint. Drop those: feeding
    // them back into lwIP would cause an infinite ARP storm.
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) {
      loopCount++;
      if (loopCount <= 3 || loopCount % 50 === 0) {
        log(`(loopback #${loopCount}; self-MAC src — dropping)`);
      }
      return;
    }
    rxCount++;
    pcapWriteFrame(pcap, frame);
    const desc = describeEthernet(frame);
    log(`RX #${rxCount}: ${desc} *** FOREIGN MAC ***`);
    process.stderr.write(`     ${hexPreview(frame)}\n`);
    foreignFrames.push({ src: desc.split(' → ')[0], frame });
    stack.injectFrame(frame);
  });
  log('receiving — press Ctrl+C to stop');

  // ---- Full ARP sweep of 169.254.0.0/16 ----
  // RFC 3927 reserves 169.254.0.0/24 and 169.254.255.0/24; valid range is
  // 169.254.1.0 .. 169.254.254.255 = 254 × 256 = 65024 addresses.
  // 1.5ms per send keeps total under ~2 minutes and stays well under bulk-OUT
  // throughput.
  const arpSweep = async () => {
    // Give AutoIP time to claim our IP before sweeping (so our sender IP is real).
    await new Promise((r) => setTimeout(r, 15_000));
    const senderIp: [number, number, number, number] = [169, 254, 200, 200];
    log(`ARP sweep 169.254.0.0/16 starting, sender=${senderIp.join('.')}`);
    let count = 0;
    const start = Date.now();
    for (let third = 1; third <= 254; third++) {
      for (let fourth = 0; fourth <= 255; fourth++) {
        const tip: [number, number, number, number] = [169, 254, third, fourth];
        const arp = buildArpRequest(ourMac, senderIp, tip);
        try {
          await wire.sendFrame(arp);
        } catch (err) {
          log(`sendFrame failed at ${tip.join('.')}: ${(err as Error).message}`);
        }
        count++;
        await new Promise((r) => setTimeout(r, 2));
      }
      const pct = ((third / 254) * 100).toFixed(1);
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      log(`sweep progress: 169.254.${third}.0/24 done (${pct}%, ${elapsed}s, ${count} sent, foreign so far=${foreignFrames.length})`);
    }
    log(`ARP sweep done: ${count} probes, ${foreignFrames.length} foreign frames seen`);
  };
  void arpSweep();

  const cleanup = async () => {
    log('shutting down…');
    stack.destroy();
    await wire.close();
    pcap.end();
    log(`captured rx=${rxCount} tx=${txCount} loopback=${loopCount} → ${pcapPath}`);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Keep the process alive.
  await new Promise(() => {});
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
