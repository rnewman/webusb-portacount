/**
 * Raw TCP SYN scanner for the Portacount 8030.
 *
 * lwIP's `tcp_connect` retries SYN with multi-second backoff — way too slow
 * to scan 65535 ports. This script crafts TCP SYN frames by hand and sends
 * them via `wire.sendFrame` at ~1ms intervals, then categorises the device's
 * replies:
 *   - SYN+ACK → port OPEN
 *   - RST     → port CLOSED (explicitly refused)
 *   - silence → FILTERED (no answer at all)
 *
 * Run:  npx tsx scripts/syn-scan.ts [first-port [last-port]]
 *       default first=1 last=65535
 */

import { WebUSB } from 'usb';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { RndisWireLayer } from '../src/rndis';

const DEVICE_IP = [169, 254, 207, 137] as const;
const DEVICE_MAC = new Uint8Array([0x02, 0x30, 0x20, 0x80, 0x73, 0xe2]);
const OUR_IP = [169, 254, 200, 200] as const;
const SRC_PORT = 56789;
const WINDOW = 0x2000;
const SEND_INTERVAL_MS = 1;
const POST_SWEEP_DRAIN_MS = 4000;

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function ip16Sum(view: Uint8Array, start: number, len: number, init = 0): number {
  let sum = init;
  for (let i = 0; i < len - 1; i += 2) {
    sum += (view[start + i] << 8) | view[start + i + 1];
  }
  if (len & 1) sum += view[start + len - 1] << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function tcpChecksum(packet: Uint8Array, ipStart: number, tcpStart: number, tcpLen: number): number {
  // pseudo-header: src IP (4), dst IP (4), zero (1), proto (1), TCP length (2)
  const pseudo = new Uint8Array(12);
  pseudo.set(packet.subarray(ipStart + 12, ipStart + 16), 0); // src IP
  pseudo.set(packet.subarray(ipStart + 16, ipStart + 20), 4); // dst IP
  pseudo[8] = 0;
  pseudo[9] = 6; // TCP
  pseudo[10] = (tcpLen >> 8) & 0xff;
  pseudo[11] = tcpLen & 0xff;
  // Sum pseudo-header + TCP segment
  let sum = 0;
  for (let i = 0; i < 12; i += 2) sum += (pseudo[i] << 8) | pseudo[i + 1];
  for (let i = 0; i < tcpLen - 1; i += 2) {
    sum += (packet[tcpStart + i] << 8) | packet[tcpStart + i + 1];
  }
  if (tcpLen & 1) sum += packet[tcpStart + tcpLen - 1] << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return ~sum & 0xffff;
}

function buildSyn(dstPort: number, seq: number): Uint8Array {
  const frame = new Uint8Array(14 + 20 + 20);  // Ethernet + IPv4 + TCP (no options)
  // Ethernet
  frame.set(DEVICE_MAC, 0);
  frame.set([0x02, 0x00, 0x00, 0x00, 0x00, 0x01], 6); // src — overwritten with our MAC at run time
  frame[12] = 0x08; frame[13] = 0x00;

  // IPv4
  const ip = 14;
  frame[ip + 0] = 0x45;             // version 4, IHL 5
  frame[ip + 1] = 0;                // DSCP/ECN
  frame[ip + 2] = 0; frame[ip + 3] = 40;  // total length
  frame[ip + 4] = (dstPort >> 8) & 0xff;  // id (use dstPort so ICMP unreach can be traced)
  frame[ip + 5] = dstPort & 0xff;
  frame[ip + 6] = 0x40;             // flags: DF
  frame[ip + 7] = 0;                // frag offset
  frame[ip + 8] = 64;               // TTL
  frame[ip + 9] = 6;                // proto TCP
  // checksum zero; computed below
  frame[ip + 10] = 0; frame[ip + 11] = 0;
  frame[ip + 12] = OUR_IP[0]; frame[ip + 13] = OUR_IP[1];
  frame[ip + 14] = OUR_IP[2]; frame[ip + 15] = OUR_IP[3];
  frame[ip + 16] = DEVICE_IP[0]; frame[ip + 17] = DEVICE_IP[1];
  frame[ip + 18] = DEVICE_IP[2]; frame[ip + 19] = DEVICE_IP[3];
  const ipChk = ip16Sum(frame, ip, 20);
  frame[ip + 10] = (ipChk >> 8) & 0xff;
  frame[ip + 11] = ipChk & 0xff;

  // TCP
  const tcp = 34;
  frame[tcp + 0] = (SRC_PORT >> 8) & 0xff;
  frame[tcp + 1] = SRC_PORT & 0xff;
  frame[tcp + 2] = (dstPort >> 8) & 0xff;
  frame[tcp + 3] = dstPort & 0xff;
  // seq
  frame[tcp + 4] = (seq >>> 24) & 0xff;
  frame[tcp + 5] = (seq >>> 16) & 0xff;
  frame[tcp + 6] = (seq >>> 8) & 0xff;
  frame[tcp + 7] = seq & 0xff;
  // ack 0
  // data offset: 5 << 4
  frame[tcp + 12] = 0x50;
  frame[tcp + 13] = 0x02;            // flags SYN
  frame[tcp + 14] = (WINDOW >> 8) & 0xff;
  frame[tcp + 15] = WINDOW & 0xff;
  // checksum zero, urg ptr zero
  const tcpChk = tcpChecksum(frame, ip, tcp, 20);
  frame[tcp + 16] = (tcpChk >> 8) & 0xff;
  frame[tcp + 17] = tcpChk & 0xff;

  return frame;
}

function buildRst(dstPort: number, seq: number, ack: number): Uint8Array {
  const frame = buildSyn(dstPort, seq);
  // tweak flags & ack to make it RST+ACK
  const tcp = 34;
  frame[tcp + 8] = (ack >>> 24) & 0xff;
  frame[tcp + 9] = (ack >>> 16) & 0xff;
  frame[tcp + 10] = (ack >>> 8) & 0xff;
  frame[tcp + 11] = ack & 0xff;
  frame[tcp + 13] = 0x14;            // RST | ACK
  // recompute TCP checksum
  frame[tcp + 16] = 0; frame[tcp + 17] = 0;
  const ip = 14;
  const tcpChk = tcpChecksum(frame, ip, tcp, 20);
  frame[tcp + 16] = (tcpChk >> 8) & 0xff;
  frame[tcp + 17] = tcpChk & 0xff;
  return frame;
}

interface Reply {
  port: number;
  kind: 'SYN_ACK' | 'RST';
  seq: number;
  ack: number;
}

function parseTcpReply(frame: Uint8Array): Reply | null {
  if (frame.byteLength < 54) return null;
  // Ethernet must be IPv4 from device to us
  if (frame[12] !== 0x08 || frame[13] !== 0x00) return null;
  const ip = 14;
  if ((frame[ip] >> 4) !== 4) return null;
  const ihl = (frame[ip] & 0x0f) * 4;
  if (frame[ip + 9] !== 6) return null; // TCP
  // source/dest IPs not strictly checked — anything from device is interesting
  const tcp = ip + ihl;
  if (frame.byteLength < tcp + 20) return null;
  const sport = (frame[tcp + 0] << 8) | frame[tcp + 1];
  const dport = (frame[tcp + 2] << 8) | frame[tcp + 3];
  if (dport !== SRC_PORT) return null;
  const seq =
    (frame[tcp + 4] << 24) | (frame[tcp + 5] << 16) | (frame[tcp + 6] << 8) | frame[tcp + 7];
  const ack =
    (frame[tcp + 8] << 24) | (frame[tcp + 9] << 16) | (frame[tcp + 10] << 8) | frame[tcp + 11];
  const flags = frame[tcp + 13];
  if ((flags & 0x12) === 0x12) return { port: sport, kind: 'SYN_ACK', seq, ack };
  if (flags & 0x04) return { port: sport, kind: 'RST', seq, ack };
  return null;
}

async function main(): Promise<void> {
  const firstPort = parseInt(process.argv[2] ?? '1', 10);
  const lastPort = parseInt(process.argv[3] ?? '65535', 10);
  log(`scan ports ${firstPort}..${lastPort} on ${DEVICE_IP.join('.')}`);

  const pcapPath = resolve(process.cwd(), 'captures/syn-scan.pcap');
  mkdirSync(dirname(pcapPath), { recursive: true });
  const pcap = createWriteStream(pcapPath);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeInt32LE(0, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(65535, 16);
  header.writeUInt32LE(1, 20);
  pcap.write(header);
  const pcapFrame = (frame: Uint8Array) => {
    const now = Date.now();
    const rec = Buffer.alloc(16 + frame.byteLength);
    rec.writeUInt32LE(Math.floor(now / 1000), 0);
    rec.writeUInt32LE((now % 1000) * 1000, 4);
    rec.writeUInt32LE(frame.byteLength, 8);
    rec.writeUInt32LE(frame.byteLength, 12);
    Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(rec, 16);
    pcap.write(rec);
  };

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
  const ourMac = wire.macAddress;

  // ARP-reply machinery: if the device ARPs for us, reply manually.
  // No lwIP this time — we don't want it RSTing or otherwise interfering.
  const arpReply = (targetMac: Uint8Array, targetIp: Uint8Array): Uint8Array => {
    const f = new Uint8Array(42);
    f.set(targetMac, 0);
    f.set(ourMac, 6);
    f[12] = 0x08; f[13] = 0x06;
    f[14] = 0; f[15] = 1;     // htype Ethernet
    f[16] = 8; f[17] = 0;     // ptype IPv4
    f[18] = 6; f[19] = 4;     // hlen, plen
    f[20] = 0; f[21] = 2;     // op REPLY
    f.set(ourMac, 22);
    f.set(OUR_IP, 28);
    f.set(targetMac, 32);
    f.set(targetIp, 38);
    return f;
  };

  const openPorts: Reply[] = [];
  const closedPorts: number[] = [];

  await wire.startReceiving((frame) => {
    // skip own loopback
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) {
      return;
    }
    pcapFrame(frame);
    // ARP request for our IP?
    if (frame.byteLength >= 42 && frame[12] === 0x08 && frame[13] === 0x06) {
      const op = (frame[20] << 8) | frame[21];
      if (op === 1) {
        const targetIp = frame.subarray(38, 42);
        const wantUs = targetIp.every((b, i) => b === OUR_IP[i]);
        if (wantUs) {
          const senderMac = frame.subarray(22, 28);
          const senderIp = frame.subarray(28, 32);
          const reply = arpReply(senderMac, senderIp);
          wire.sendFrame(reply).catch(() => {});
        }
      }
      return;
    }
    const r = parseTcpReply(frame);
    if (!r) return;
    if (r.kind === 'SYN_ACK') {
      log(`*** OPEN: port ${r.port}`);
      openPorts.push(r);
      // Immediately tear down so we don't fill the device's connection table.
      // (Send RST: ack the SYN-ACK by setting our ack = their seq + 1.)
      const rst = buildRst(r.port, r.ack, (r.seq + 1) >>> 0);
      wire.sendFrame(rst).catch(() => {});
    } else if (r.kind === 'RST') {
      closedPorts.push(r.port);
    }
  });

  // Send one ARP first so the device knows our MAC (and possibly populates its
  // own ARP cache before we start blasting SYNs).
  const arpRequest = new Uint8Array(42);
  arpRequest.set([0xff, 0xff, 0xff, 0xff, 0xff, 0xff], 0);
  arpRequest.set(ourMac, 6);
  arpRequest[12] = 0x08; arpRequest[13] = 0x06;
  arpRequest[14] = 0; arpRequest[15] = 1;
  arpRequest[16] = 8; arpRequest[17] = 0;
  arpRequest[18] = 6; arpRequest[19] = 4;
  arpRequest[20] = 0; arpRequest[21] = 1; // REQ
  arpRequest.set(ourMac, 22);
  arpRequest.set(OUR_IP, 28);
  arpRequest.set(DEVICE_IP, 38);
  await wire.sendFrame(arpRequest);
  await new Promise((r) => setTimeout(r, 200));

  log(`sending SYNs (${lastPort - firstPort + 1} ports, ~${SEND_INTERVAL_MS}ms each)`);
  const start = Date.now();
  let sent = 0;
  for (let port = firstPort; port <= lastPort; port++) {
    const seq = (port * 0x100007) >>> 0;
    const frame = buildSyn(port, seq);
    // patch in our real MAC
    frame.set(ourMac, 6);
    // re-checksum if needed — but we built the IP checksum with the placeholder MAC?
    // No — Ethernet header isn't part of the IP/TCP checksums. OK.
    try {
      await wire.sendFrame(frame);
    } catch (err) {
      log(`send port ${port}: ${(err as Error).message}`);
    }
    sent++;
    if (sent % 5000 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`progress: ${sent}/${lastPort - firstPort + 1} (${elapsed}s, open=${openPorts.length} closed=${closedPorts.length})`);
    }
    await new Promise((r) => setTimeout(r, SEND_INTERVAL_MS));
  }
  log(`all SYNs sent in ${((Date.now() - start) / 1000).toFixed(1)}s; draining for ${POST_SWEEP_DRAIN_MS}ms`);
  await new Promise((r) => setTimeout(r, POST_SWEEP_DRAIN_MS));

  log(`--- RESULTS ---`);
  log(`OPEN  (${openPorts.length}): ${openPorts.map((p) => p.port).sort((a, b) => a - b).join(', ') || '(none)'}`);
  log(`RST   (${closedPorts.length})`);
  log(`silent: ${lastPort - firstPort + 1 - openPorts.length - closedPorts.length}`);
  log(`pcap: ${pcapPath}`);

  await wire.close();
  pcap.end();
  process.exit(0);
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
