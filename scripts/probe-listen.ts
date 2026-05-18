/**
 * Portacount 8030 passive listener.
 *
 * Brings up RNDIS + lwIP with a static 169.254.200.200/16, then sits silent.
 * lwIP will ARP-reply to anything asking for us. Every Ethernet frame
 * arriving on bulk-IN with a non-self source MAC is logged to stderr (with
 * full hex + decode) and written to pcap.
 *
 * Use this while interacting with the device (button presses, mode changes)
 * to see if it ever initiates traffic toward us.
 *
 * Run:  npx tsx scripts/probe-listen.ts [output.pcap]
 * Stop: Ctrl+C
 */

import { WebUSB } from 'usb';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { RndisWireLayer } from '../src/rndis';
import { LwipStack, type IpOctets } from '../src/lwip-wasm';

const OUR_IP: IpOctets = [169, 254, 200, 200];
const NETMASK: IpOctets = [255, 255, 0, 0];

const PCAP_LINKTYPE_ETHERNET = 1;
const SNAPLEN = 65535;

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

function openPcap(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0);
  header.writeUInt16LE(2, 4);
  header.writeUInt16LE(4, 6);
  header.writeInt32LE(0, 8);
  header.writeUInt32LE(0, 12);
  header.writeUInt32LE(SNAPLEN, 16);
  header.writeUInt32LE(PCAP_LINKTYPE_ETHERNET, 20);
  stream.write(header);
  return stream;
}

function pcapWriteFrame(stream: WriteStream, frame: Uint8Array): void {
  const now = Date.now();
  const rec = Buffer.alloc(16 + frame.byteLength);
  rec.writeUInt32LE(Math.floor(now / 1000), 0);
  rec.writeUInt32LE((now % 1000) * 1000, 4);
  rec.writeUInt32LE(frame.byteLength, 8);
  rec.writeUInt32LE(frame.byteLength, 12);
  Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(rec, 16);
  stream.write(rec);
}

function hex(buf: Uint8Array): string {
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function describeFrame(frame: Uint8Array): string {
  if (frame.byteLength < 14) return `runt ${frame.byteLength}B`;
  const dst = [...frame.subarray(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const src = [...frame.subarray(6, 12)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const etype = (frame[12] << 8) | frame[13];

  if (etype === 0x0806) {
    const arp = frame.subarray(14);
    if (arp.byteLength >= 28) {
      const op = (arp[6] << 8) | arp[7];
      const sIp = `${arp[14]}.${arp[15]}.${arp[16]}.${arp[17]}`;
      const tIp = `${arp[24]}.${arp[25]}.${arp[26]}.${arp[27]}`;
      const opName = op === 1 ? 'REQ' : op === 2 ? 'REPLY' : `op${op}`;
      return `${src}→${dst}  ARP ${opName} ${sIp} → ${tIp}`;
    }
  } else if (etype === 0x0800) {
    const ip = frame.subarray(14);
    if (ip.byteLength >= 20) {
      const proto = ip[9];
      const sIp = `${ip[12]}.${ip[13]}.${ip[14]}.${ip[15]}`;
      const dIp = `${ip[16]}.${ip[17]}.${ip[18]}.${ip[19]}`;
      const ihl = (ip[0] & 0x0f) * 4;
      let info = `proto=${proto}`;
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
        info = `TCP ${sport}→${dport}${flagStr ? ` [${flagStr}]` : ''}`;
      } else if (proto === 17 && ip.byteLength >= ihl + 8) {
        const sport = (ip[ihl] << 8) | ip[ihl + 1];
        const dport = (ip[ihl + 2] << 8) | ip[ihl + 3];
        info = `UDP ${sport}→${dport}`;
      } else if (proto === 1) {
        info = 'ICMP';
      }
      return `${src}→${dst}  IPv4 ${sIp}→${dIp} ${info}`;
    }
  } else if (etype === 0x86dd) {
    return `${src}→${dst}  IPv6`;
  }
  return `${src}→${dst}  etype=0x${etype.toString(16).padStart(4, '0')}`;
}

async function main(): Promise<void> {
  const pcapPath = resolve(process.cwd(), process.argv[2] ?? 'captures/portacount-listen.pcap');
  log(`pcap output: ${pcapPath}`);
  log(`our IP: ${OUR_IP.join('.')}/16`);

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
  const pcap = openPcap(pcapPath);
  let foreignCount = 0;

  const stack = await LwipStack.create(
    pathToFileURL(resolve(process.cwd(), 'build/lwip.js')).href,
    ourMac,
    (frame) => {
      pcapWriteFrame(pcap, frame);
      // Quietly suppress TX from logging — most will be ARP replies.
    },
    {
      ip: OUR_IP,
      netmask: NETMASK,
      onIpStatus: (ip) => log(`lwIP IP status: ${ip}`),
    },
  );

  await wire.startReceiving((frame) => {
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) {
      // self-loopback — skip
      return;
    }
    foreignCount++;
    pcapWriteFrame(pcap, frame);
    log(`>>> #${foreignCount} ${describeFrame(frame)}`);
    process.stderr.write(`    ${hex(frame)}\n`);
    stack.injectFrame(frame);
  });

  log('listening — press buttons / change modes on the device. Ctrl+C to stop.');

  const cleanup = async () => {
    log('shutting down…');
    stack.destroy();
    await wire.close();
    pcap.end();
    log(`captured ${foreignCount} foreign frames → ${pcapPath}`);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  await new Promise(() => {});
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
