/**
 * First-contact probe for a real PortaCount 8020.
 *
 * Opens a serial port, listens for the boot banner, then walks the
 * command vocabulary while logging raw bytes both directions. Output
 * lands in two files under `local/captures/8020/`:
 *
 *   <timestamp>.bin   — append-only binary capture, with per-chunk
 *                       headers so the same file can be replayed.
 *                       Format: `[8-byte header][payload]` where the
 *                       header is `<dir:1><tv_sec:4 le><tv_usec:3 le>`,
 *                       dir = 'T' for TX (host → device) or 'R' for RX.
 *   <timestamp>.log   — human-readable timeline (ASCII + hex for
 *                       non-printable bytes, parsed events, asserts).
 *
 * Usage:
 *   npx tsx scripts/probe-8020.ts                            # uses defaults
 *   npx tsx scripts/probe-8020.ts --port=/dev/cu.foo --baud=9600
 *   npx tsx scripts/probe-8020.ts --pre-listen-sec=10
 */

import fs from 'node:fs';
import path from 'node:path';
import { SerialPort } from 'serialport';
import { LineAssembler } from '../src/8020/line-assembler';
import { parseLine, type ParsedEvent, type UnknownLine } from '../src/8020/parser';
import { BootBannerCollector } from '../src/8020/boot-banner';

interface Args {
  port: string;
  baud: number;
  preListenSec: number;
}

function parseArgs(): Args {
  const args: Args = {
    port: '/dev/cu.usbserial-FTB6SPL3',
    baud: 1200,
    preListenSec: 5,
  };
  for (const a of process.argv.slice(2)) {
    const m = /^--(\w[\w-]*)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'port') args.port = v;
    else if (k === 'baud') args.baud = parseInt(v, 10);
    else if (k === 'pre-listen-sec') args.preListenSec = parseFloat(v);
  }
  return args;
}

function ts(): string {
  return new Date().toISOString();
}

function shortTs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function hexDump(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

function asciiSafe(buf: Uint8Array): string {
  let out = '';
  for (const b of buf) {
    if (b === 0x0d) out += '\\r';
    else if (b === 0x0a) out += '\\n';
    else if (b >= 0x20 && b < 0x7f) out += String.fromCharCode(b);
    else out += `\\x${b.toString(16).padStart(2, '0')}`;
  }
  return out;
}

class Capture {
  private bin: fs.WriteStream;
  private log: fs.WriteStream;
  readonly binPath: string;
  readonly logPath: string;

  constructor(dir: string, stem: string) {
    this.binPath = path.join(dir, `${stem}.bin`);
    this.logPath = path.join(dir, `${stem}.log`);
    this.bin = fs.createWriteStream(this.binPath);
    this.log = fs.createWriteStream(this.logPath);
  }

  writeFrame(dir: 'T' | 'R', payload: Uint8Array): void {
    const now = process.hrtime.bigint();
    const us = Number(now / 1000n);
    const header = Buffer.alloc(8);
    header.writeUInt8(dir.charCodeAt(0), 0);
    header.writeUInt32LE(Math.floor(us / 1_000_000), 1);
    header.writeUIntLE(us % 1_000_000, 5, 3);
    this.bin.write(header);
    this.bin.write(Buffer.from(payload));
  }

  note(msg: string): void {
    const line = `[${ts()}] ${msg}\n`;
    this.log.write(line);
    process.stdout.write(line);
  }

  close(): Promise<void> {
    return Promise.all([
      new Promise<void>((r) => this.bin.end(r)),
      new Promise<void>((r) => this.log.end(r)),
    ]).then(() => undefined);
  }
}

async function openPort(args: Args): Promise<SerialPort> {
  return new Promise<SerialPort>((resolve, reject) => {
    const port = new SerialPort(
      {
        path: args.port,
        baudRate: args.baud,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        rtscts: false,
        xon: false,
        xoff: false,
        autoOpen: false,
      },
      (err) => {
        if (err) reject(err);
      },
    );
    port.open((err) => {
      if (err) reject(err);
      else resolve(port);
    });
  });
}

async function writeAndWait(
  port: SerialPort,
  cap: Capture,
  cmd: string,
  waitMs: number,
): Promise<void> {
  const payload = Buffer.from(cmd + '\r', 'ascii');
  cap.note(`TX  ${JSON.stringify(cmd)}    (${hexDump(payload)})`);
  cap.writeFrame('T', payload);
  await new Promise<void>((resolve, reject) =>
    port.write(payload, (err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    port.drain((err) => (err ? reject(err) : resolve())),
  );
  await new Promise((r) => setTimeout(r, waitMs));
}

async function listen(cap: Capture, ms: number, why: string): Promise<void> {
  cap.note(`-- listening ${ms} ms (${why}) --`);
  await new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const captureDir = path.resolve(import.meta.dirname, '..', 'local', 'captures', '8020');
  fs.mkdirSync(captureDir, { recursive: true });
  const cap = new Capture(captureDir, shortTs());

  cap.note(`probe-8020 starting`);
  cap.note(`  port=${args.port}  baud=${args.baud}  pre-listen=${args.preListenSec}s`);
  cap.note(`  bin=${cap.binPath}`);
  cap.note(`  log=${cap.logPath}`);

  const port = await openPort(args);
  cap.note(`port open.`);

  const assembler = new LineAssembler();
  const banner = new BootBannerCollector();
  let unknownCount = 0;
  const seenKinds = new Map<string, number>();

  port.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    cap.writeFrame('R', bytes);
    cap.note(`RX  ${JSON.stringify(asciiSafe(bytes))}    (${hexDump(bytes)})`);
    const lines = assembler.push(bytes);
    for (const line of lines) {
      const event = parseLine(line);
      if (event === null) continue;
      banner.push(event);
      const kind = event.kind;
      seenKinds.set(kind, (seenKinds.get(kind) ?? 0) + 1);
      if (kind === 'unknown') {
        unknownCount += 1;
        cap.note(`  parsed: UNKNOWN line=${JSON.stringify((event as UnknownLine).line)}`);
      } else {
        cap.note(`  parsed: ${kind} ${summarizeEvent(event as ParsedEvent)}`);
      }
    }
  });

  // Phase 1: listen for the boot banner (or whatever the device is
  // currently dribbling out).
  await listen(cap, args.preListenSec * 1000, 'pre-TX (banner / current state)');

  // Phase 2: structured command walk.
  cap.note('==== command walk ====');
  await writeAndWait(port, cap, 'J', 1500); // external control
  await writeAndWait(port, cap, 'R', 1500); // runtime status
  await writeAndWait(port, cap, 'Q', 1500); // N95 companion probe
  await writeAndWait(port, cap, 'S', 3000); // settings burst
  await writeAndWait(port, cap, 'C', 2500); // voltage burst
  await writeAndWait(port, cap, 'ZE', 4000); // 4 s of external-mode stream
  await writeAndWait(port, cap, 'ZD', 1000);
  await writeAndWait(port, cap, 'VN', 1000);
  await writeAndWait(port, cap, 'VF', 1000);
  await writeAndWait(port, cap, 'VN', 500);
  await writeAndWait(port, cap, 'G', 4000); // release → 4 s of internal mode

  // Phase 3: summary.
  cap.note('==== summary ====');
  cap.note(`event counts:`);
  const kinds = Array.from(seenKinds.entries()).sort((a, b) => b[1] - a[1]);
  for (const [kind, count] of kinds) cap.note(`  ${count.toString().padStart(4)} × ${kind}`);
  cap.note(`unknown lines: ${unknownCount}`);

  const id = banner.identity;
  cap.note(`identity (from banner accumulator):`);
  cap.note(`  complete:        ${id.complete}`);
  cap.note(`  firmwareVersion: ${id.firmwareVersion ?? '—'}`);
  cap.note(`  copyrightYear:   ${id.copyrightYear ?? '—'}`);
  cap.note(`  serialNumber:    ${id.serialNumber ?? '—'}`);
  cap.note(`  ffPassLevel:     ${id.ffPassLevel ?? '—'}`);
  cap.note(`  exerciseCount:   ${id.exerciseCount ?? '—'}`);
  cap.note(`  ambient purge:   ${id.ambientPurgeSec ?? '—'} sec`);
  cap.note(`  ambient sample:  ${id.ambientSampleSec ?? '—'} sec`);
  cap.note(`  mask purge:      ${id.maskPurgeSec ?? '—'} sec`);
  cap.note(`  mask samples:    ${JSON.stringify(id.maskSampleSec)}`);
  cap.note(`  DIP switches:    ${id.dipSwitch ?? '—'}`);

  // Hand back the unfinished line (if any) so the log shows whether
  // we cut off mid-token.
  const trailing = assembler.takeBuffered();
  if (trailing.length > 0) {
    cap.note(`trailing unterminated bytes: ${JSON.stringify(trailing)}`);
  }

  cap.note('closing port.');
  await new Promise<void>((resolve, reject) =>
    port.close((err) => (err ? reject(err) : resolve())),
  );
  await cap.close();
}

function summarizeEvent(e: ParsedEvent): string {
  const { kind: _, ...rest } = e as unknown as { kind: string };
  return JSON.stringify(rest);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
