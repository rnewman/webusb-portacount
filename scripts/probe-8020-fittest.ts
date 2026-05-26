/**
 * Host-driven fit test for the PortaCount 8020.
 *
 * The 8020 has no "start test" command. In external control, the
 * device is just a particle counter with a remote-controlled valve;
 * the host is the test orchestrator. This probe runs the canonical
 * cycle:
 *
 *   for each exercise:
 *     1. valve → ambient (VN)
 *     2. ambient purge: wait, discard samples
 *     3. ambient sample: collect particle counts
 *     4. valve → mask (VF)
 *     5. mask purge: wait, discard samples
 *     6. mask sample: collect particle counts
 *     7. FF = mean(ambient) / mean(mask)
 *
 * Overall FF (multi-exercise) is the harmonic mean of per-exercise
 * FFs, per OSHA convention.
 *
 * Usage:
 *   npx tsx scripts/probe-8020-fittest.ts                    # 1 exercise, real timing
 *   npx tsx scripts/probe-8020-fittest.ts --exercises=4
 *   npx tsx scripts/probe-8020-fittest.ts --quick            # compressed times
 *   npx tsx scripts/probe-8020-fittest.ts --port=/dev/cu.x   # alternate port
 */

import fs from 'node:fs';
import path from 'node:path';
import { SerialPort } from 'serialport';
import { LineAssembler } from '../src/8020/line-assembler';
import { parseLine } from '../src/8020/parser';

interface Args {
  port: string;
  baud: number;
  exercises: number;
  ambientPurgeSec: number;
  ambientSampleSec: number;
  maskPurgeSec: number;
  maskSampleSec: number;
  passLevel: number;
}

function parseArgs(): Args {
  const args: Args = {
    port: '/dev/cu.usbserial-FTB6SPL3',
    baud: 1200,
    exercises: 1,
    ambientPurgeSec: 4,
    ambientSampleSec: 5,
    maskPurgeSec: 11,
    maskSampleSec: 40,
    passLevel: 100,
  };
  for (const a of process.argv.slice(2)) {
    if (a === '--quick') {
      args.ambientPurgeSec = 2;
      args.ambientSampleSec = 3;
      args.maskPurgeSec = 2;
      args.maskSampleSec = 5;
      continue;
    }
    const m = /^--(\w[\w-]*)=(.+)$/.exec(a);
    if (!m) continue;
    const [, k, v] = m;
    const n = parseFloat(v);
    if (k === 'port') args.port = v;
    else if (k === 'baud') args.baud = parseInt(v, 10);
    else if (k === 'exercises') args.exercises = parseInt(v, 10);
    else if (k === 'ambient-purge-sec') args.ambientPurgeSec = n;
    else if (k === 'ambient-sample-sec') args.ambientSampleSec = n;
    else if (k === 'mask-purge-sec') args.maskPurgeSec = n;
    else if (k === 'mask-sample-sec') args.maskSampleSec = n;
    else if (k === 'pass-level') args.passLevel = n;
  }
  return args;
}

function ts(): string {
  return new Date().toISOString();
}

function shortTs(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace(/Z$/, '');
}

class Capture {
  private log: fs.WriteStream;
  readonly logPath: string;
  constructor(dir: string, stem: string) {
    this.logPath = path.join(dir, `${stem}.log`);
    this.log = fs.createWriteStream(this.logPath);
  }
  note(msg: string): void {
    const line = `[${ts()}] ${msg}\n`;
    this.log.write(line);
    process.stdout.write(line);
  }
  close(): Promise<void> {
    return new Promise<void>((r) => this.log.end(r));
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function harmonicMean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sumRecip = xs.reduce((acc, x) => acc + (x > 0 ? 1 / x : Infinity), 0);
  return xs.length / sumRecip;
}

interface PhaseConfig {
  name: 'ambient-purge' | 'ambient-sample' | 'mask-purge' | 'mask-sample';
  durationMs: number;
  /** True if we should bucket samples in this phase. */
  collect: boolean;
  /** Side this phase samples — for labelling. */
  side: 'ambient' | 'mask';
}

interface ExerciseResult {
  exerciseNumber: number;
  ambientSamples: number[];
  maskSamples: number[];
  meanAmbient: number;
  meanMask: number;
  ff: number;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const dir = path.resolve(import.meta.dirname, '..', 'local', 'captures', '8020');
  fs.mkdirSync(dir, { recursive: true });
  const cap = new Capture(dir, `${shortTs()}-fittest`);

  cap.note('host-driven fit test');
  cap.note(`  port=${args.port}  baud=${args.baud}`);
  cap.note(`  exercises=${args.exercises}  passLevel=${args.passLevel}`);
  cap.note(
    `  timing: ambient ${args.ambientPurgeSec}s purge / ${args.ambientSampleSec}s sample, ` +
      `mask ${args.maskPurgeSec}s purge / ${args.maskSampleSec}s sample`,
  );
  const perExSec =
    args.ambientPurgeSec + args.ambientSampleSec + args.maskPurgeSec + args.maskSampleSec;
  cap.note(`  → ${perExSec}s per exercise, ${perExSec * args.exercises}s total`);

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
  cap.note('port open.');

  // Bookkeeping for the line stream.
  const assembler = new LineAssembler();
  const send = async (cmd: string) =>
    new Promise<void>((resolve, reject) => {
      cap.note(`TX ${JSON.stringify(cmd)}`);
      port.write(Buffer.from(cmd + '\r', 'ascii'), (err) =>
        err ? reject(err) : port.drain((e) => (e ? reject(e) : resolve())),
      );
    });

  /** Currently sampled concentrations get pushed here while we're in a
   * collecting phase. Null when discarding. */
  let bucket: number[] | null = null;
  /** Most recent concentration reading, for live status display. */
  let lastConc: number | null = null;

  port.on('data', (chunk: Buffer) => {
    const bytes = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const lines = assembler.push(bytes);
    for (const raw of lines) {
      const line = raw.replace(/\0+/g, '');
      if (line.length === 0) continue;
      const event = parseLine(line);
      if (event && event.kind === 'particle-count') {
        lastConc = event.concentration;
        if (bucket !== null) bucket.push(event.concentration);
      }
    }
  });

  // Wait helper that emits a status line every ~2 s. The caller is
  // responsible for the bucket: pass one in to collect samples during
  // this phase, or null to discard. (Earlier versions of this script
  // had `phase()` allocate its own bucket and clobber the caller's,
  // which silently produced empty per-exercise sample arrays.)
  const phase = async (
    cfg: PhaseConfig,
    exerciseNum: number,
    intoBucket: number[] | null,
  ): Promise<void> => {
    cap.note(
      `  ── exercise ${exerciseNum} · ${cfg.name} (${intoBucket ? 'COLLECT' : 'discard'}) ${(cfg.durationMs / 1000).toFixed(0)}s ──`,
    );
    bucket = intoBucket;
    const start = Date.now();
    const deadline = start + cfg.durationMs;
    const tickHandle = setInterval(() => {
      const remaining = Math.max(0, deadline - Date.now()) / 1000;
      const collected = bucket?.length ?? 0;
      cap.note(
        `    t=${((Date.now() - start) / 1000).toFixed(1)}s  remaining=${remaining.toFixed(0)}s  conc=${lastConc?.toFixed(2) ?? '—'}  samples=${collected}`,
      );
    }, 2000);
    await new Promise((r) => setTimeout(r, cfg.durationMs));
    clearInterval(tickHandle);
    if (intoBucket && intoBucket.length > 0) {
      cap.note(
        `    collected ${intoBucket.length} samples: min=${Math.min(...intoBucket).toFixed(2)}  max=${Math.max(...intoBucket).toFixed(2)}  mean=${mean(intoBucket).toFixed(2)}`,
      );
    }
    bucket = null;
  };

  // Sync: external control + data transmission.
  cap.note('==== sync ====');
  await send('J');
  await new Promise((r) => setTimeout(r, 500));
  await send('ZE');
  await new Promise((r) => setTimeout(r, 500));
  // Default valve position is ambient by convention.
  await send('VN');
  await new Promise((r) => setTimeout(r, 200));

  // Run exercises.
  const exercises: ExerciseResult[] = [];
  for (let i = 1; i <= args.exercises; i++) {
    cap.note(`==== exercise ${i} ====`);
    // 1. Valve → ambient.
    await send('VN');
    // 2. Ambient purge.
    await phase(
      {
        name: 'ambient-purge',
        durationMs: args.ambientPurgeSec * 1000,
        collect: false,
        side: 'ambient',
      },
      i,
      null,
    );
    // 3. Ambient sample.
    const ambSamples: number[] = [];
    await phase(
      {
        name: 'ambient-sample',
        durationMs: args.ambientSampleSec * 1000,
        collect: true,
        side: 'ambient',
      },
      i,
      ambSamples,
    );

    // 4. Valve → mask.
    await send('VF');
    // 5. Mask purge.
    await phase(
      {
        name: 'mask-purge',
        durationMs: args.maskPurgeSec * 1000,
        collect: false,
        side: 'mask',
      },
      i,
      null,
    );
    // 6. Mask sample.
    const maskSamples: number[] = [];
    await phase(
      {
        name: 'mask-sample',
        durationMs: args.maskSampleSec * 1000,
        collect: true,
        side: 'mask',
      },
      i,
      maskSamples,
    );

    // 7. Compute FF.
    const meanAmb = mean(ambSamples);
    const meanMask = mean(maskSamples);
    const ff = meanMask > 0 ? meanAmb / meanMask : Infinity;
    exercises.push({
      exerciseNumber: i,
      ambientSamples: ambSamples,
      maskSamples,
      meanAmbient: meanAmb,
      meanMask,
      ff,
    });
    cap.note(
      `  ✱ exercise ${i}: amb̄=${meanAmb.toFixed(2)}  mask̄=${meanMask.toFixed(2)}  FF=${Number.isFinite(ff) ? ff.toFixed(0) : '∞'}`,
    );
  }

  // Return valve to ambient as a courtesy.
  await send('VN');

  // Summary.
  cap.note('==== result ====');
  for (const e of exercises) {
    const pf = e.ff >= args.passLevel ? 'PASS' : 'FAIL';
    cap.note(
      `  exercise ${e.exerciseNumber}: FF=${Number.isFinite(e.ff) ? e.ff.toFixed(0) : '∞'} (${pf})  ` +
        `amb̄=${e.meanAmbient.toFixed(2)}  mask̄=${e.meanMask.toFixed(2)}  ` +
        `(${e.ambientSamples.length} amb + ${e.maskSamples.length} mask samples)`,
    );
  }
  if (exercises.length > 1) {
    const ffs = exercises.map((e) => e.ff).filter((x) => Number.isFinite(x));
    const overall = harmonicMean(ffs);
    const overallPf = overall >= args.passLevel ? 'PASS' : 'FAIL';
    cap.note(
      `  overall FF (harmonic mean): ${overall.toFixed(0)} (${overallPf}, pass level ${args.passLevel})`,
    );
  }

  cap.note('closing port.');
  await new Promise<void>((resolve) => port.close(() => resolve()));
  await cap.close();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
