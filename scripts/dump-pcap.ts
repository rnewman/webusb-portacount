/**
 * Minimal pcap dumper. Reads a libpcap-format file and prints one line per
 * frame: timestamp, length, src→dst MAC, ethertype, IP summary.
 *
 * Run:  npx tsx scripts/dump-pcap.ts captures/probe-XXX.pcap [--full]
 *
 * Use `--full` to also dump the full hex of each frame.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function fmtMac(buf: Uint8Array, off: number): string {
  return [...buf.subarray(off, off + 6)].map((b) => b.toString(16).padStart(2, '0')).join(':');
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
  return `IPv4 ${src}→${dst}${suffix}`;
}

function describeArp(arp: Uint8Array): string {
  if (arp.byteLength < 28) return 'ARP runt';
  const op = (arp[6] << 8) | arp[7];
  const senderMac = [...arp.subarray(8, 14)].map((b) => b.toString(16).padStart(2, '0')).join(':');
  const senderIp = `${arp[14]}.${arp[15]}.${arp[16]}.${arp[17]}`;
  const targetIp = `${arp[24]}.${arp[25]}.${arp[26]}.${arp[27]}`;
  const opName = op === 1 ? 'REQ' : op === 2 ? 'REPLY' : `op${op}`;
  return `ARP ${opName} who-has ${targetIp}? tell ${senderIp} (${senderMac})`;
}

function describeEth(frame: Uint8Array): string {
  if (frame.byteLength < 14) return `runt (${frame.byteLength}B)`;
  const dst = fmtMac(frame, 0);
  const src = fmtMac(frame, 6);
  const etype = (frame[12] << 8) | frame[13];
  let proto = `etype=0x${etype.toString(16).padStart(4, '0')}`;
  if (etype === 0x0806) proto = describeArp(frame.subarray(14));
  else if (etype === 0x0800) proto = describeIpv4(frame.subarray(14));
  else if (etype === 0x86dd) proto = 'IPv6';
  return `${src}→${dst}  ${proto}  ${frame.byteLength}B`;
}

function main(): void {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write('usage: tsx scripts/dump-pcap.ts <file.pcap> [--full]\n');
    process.exit(1);
  }
  const full = process.argv.includes('--full');
  const buf = readFileSync(resolve(process.cwd(), path));
  if (buf.byteLength < 24) {
    process.stderr.write('file too short for pcap header\n');
    process.exit(1);
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== 0xa1b2c3d4) {
    process.stderr.write(`bad pcap magic 0x${magic.toString(16)}\n`);
    process.exit(1);
  }
  let off = 24;
  let n = 0;
  // Per-source frame counter to spot loopbacks/duplicates.
  const srcCounts = new Map<string, number>();
  while (off + 16 <= buf.byteLength) {
    const tsSec = dv.getUint32(off, true);
    const tsUsec = dv.getUint32(off + 4, true);
    const inclLen = dv.getUint32(off + 8, true);
    off += 16;
    if (off + inclLen > buf.byteLength) break;
    const frame = new Uint8Array(buf.buffer, buf.byteOffset + off, inclLen);
    off += inclLen;
    n++;
    const ts = new Date(tsSec * 1000 + Math.floor(tsUsec / 1000)).toISOString().substring(11, 23);
    const src = inclLen >= 12 ? fmtMac(frame, 6) : '??';
    srcCounts.set(src, (srcCounts.get(src) ?? 0) + 1);
    process.stdout.write(`[${ts}] #${n} ${describeEth(frame)}\n`);
    if (full) {
      const hex = [...frame].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      process.stdout.write(`     ${hex}\n`);
    }
  }
  process.stdout.write(`\n${n} frame(s); per-source counts:\n`);
  for (const [src, count] of [...srcCounts.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${src}: ${count}\n`);
  }
}

main();
