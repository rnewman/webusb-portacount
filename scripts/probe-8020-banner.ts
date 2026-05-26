/**
 * Banner-catch probe.
 *
 * Opens the serial port and just listens for up to `--listen-sec` (60
 * by default). The 8020 only emits its boot banner at power-on, so
 * the operator should:
 *
 *   1. Run this script. Wait for "go" prompt.
 *   2. Power-cycle the device.
 *   3. Watch identity fields populate live.
 *   4. Banner ends with `DIP switch = NNNNNNNN` — once that arrives,
 *      `complete: true` and we exit early.
 *
 * Raw capture is teed to the same directory as `probe-8020.ts`.
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
  listenSec: number;
}

function parseArgs(): Args {
  const args: Args = {
    port: '/dev/cu.usbserial-FTB6SPL3',
    baud: 1200,
    listenSec: 60,
  };
  for (const a of process.argv.slice(2)) {
    const m = /^--(\w[\w-]*)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    if (k === 'port') args.port = v;
    else if (k === 'baud') args.baud = parseInt(v, 10);
    else if (k === 'listen-sec') args.listenSec = parseFloat(v);
  }
  return args;
}

function shortTs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

function ts(): string {
  return new Date().toISOString();
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

async function main(): Promise<void> {
  const args = parseArgs();
  const dir = path.resolve(import.meta.dirname, '..', 'local', 'captures', '8020');
  fs.mkdirSync(dir, { recursive: true });
  const stem = `${shortTs()}-banner`;
  const binPath = path.join(dir, `${stem}.bin`);
  const logPath = path.join(dir, `${stem}.log`);
  const binFile = fs.createWriteStream(binPath);
  const logFile = fs.createWriteStream(logPath);

  const note = (msg: string) => {
    const line = `[${ts()}] ${msg}\n`;
    logFile.write(line);
    process.stdout.write(line);
  };

  note(`banner probe: port=${args.port} baud=${args.baud} listen=${args.listenSec}s`);
  note(`  bin=${binPath}`);
  note(`  log=${logPath}`);

  const port = await new Promise<SerialPort>((resolve, reject) => {
    const p = new SerialPort(
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
    p.open((err) => (err ? reject(err) : resolve(p)));
  });
  note(`port open. ⏳ POWER-CYCLE THE DEVICE NOW.`);
  note(`(waiting up to ${args.listenSec}s for the banner — Ctrl-C anytime to bail)`);
  note('');

  const assembler = new LineAssembler();
  const banner = new BootBannerCollector();

  banner.subscribe((id) => {
    if (id.complete) {
      note(`identity COMPLETE:`);
      note(`  firmwareVersion: ${id.firmwareVersion ?? '—'}`);
      note(`  copyrightYear:   ${id.copyrightYear ?? '—'}`);
      note(`  serialNumber:    ${id.serialNumber ?? '—'}`);
      note(`  ffPassLevel:     ${id.ffPassLevel ?? '—'}`);
      note(`  exerciseCount:   ${id.exerciseCount ?? '—'}`);
      note(`  ambient purge:   ${id.ambientPurgeSec ?? '—'} sec`);
      note(`  ambient sample:  ${id.ambientSampleSec ?? '—'} sec`);
      note(`  mask purge:      ${id.maskPurgeSec ?? '—'} sec`);
      note(`  mask samples:    ${JSON.stringify(id.maskSampleSec)}`);
      note(`  DIP switches:    ${id.dipSwitch ?? '—'}`);
      finish().catch(() => {
        /* nothing useful to do on error */
      });
    }
  });

  let finished = false;
  async function finish(): Promise<void> {
    if (finished) return;
    finished = true;
    note('closing port.');
    await new Promise<void>((resolve) => port.close(() => resolve()));
    await Promise.all([
      new Promise<void>((r) => binFile.end(r)),
      new Promise<void>((r) => logFile.end(r)),
    ]);
    process.exit(0);
  }

  port.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    binFile.write(Buffer.from(bytes));
    // Print raw chunks compactly so the operator sees activity.
    const repr = asciiSafe(bytes);
    if (repr.replace(/\\x00/g, '').length === 0) {
      // NUL-only chunk; collapse into a single tally line.
      process.stdout.write(`[${ts()}] RX (${bytes.length}× NUL)\n`);
      logFile.write(`[${ts()}] RX (${bytes.length}× NUL)\n`);
    } else {
      note(`RX  ${JSON.stringify(repr)}`);
    }
    const lines = assembler.push(bytes);
    for (const line of lines) {
      // Drop NUL-only lines; everything else gets parsed.
      const stripped = line.replace(/\0+/g, '');
      if (stripped.length === 0) continue;
      const event = parseLine(stripped);
      if (event === null) continue;
      banner.push(event);
      if (event.kind === 'unknown') {
        note(`  parsed: UNKNOWN ${JSON.stringify((event as UnknownLine).line)}`);
      } else {
        const { kind: _k, ...rest } = event as unknown as { kind: string };
        note(`  parsed: ${(event as ParsedEvent).kind} ${JSON.stringify(rest)}`);
      }
    }
  });

  // Timeout fallback.
  setTimeout(() => {
    note(`⏱  ${args.listenSec}s elapsed without seeing DIP switch — bailing.`);
    const id = banner.identity;
    note(`identity (partial):`);
    note(`  firmwareVersion: ${id.firmwareVersion ?? '—'}`);
    note(`  serialNumber:    ${id.serialNumber ?? '—'}`);
    note(`  DIP switches:    ${id.dipSwitch ?? '—'}`);
    finish().catch(() => undefined);
  }, args.listenSec * 1000);

  process.on('SIGINT', () => {
    note('SIGINT — bailing.');
    void finish();
  });
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
