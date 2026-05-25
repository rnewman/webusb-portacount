/**
 * Standalone PortaCount 8020 simulator.
 *
 * Runs as a Node process and exposes the 8020 wire protocol over a
 * WebSocket so the webapp (or test code) can connect without needing
 * a real serial port. Each WebSocket frame carries a chunk of
 * "device output" bytes; client→server frames carry "host input"
 * bytes. The simulator parses commands at `\r` boundaries, mirroring
 * what a real serial port would deliver.
 *
 * Run:
 *   tsx simulator/portacount-8020.ts            # default port 18020
 *   tsx simulator/portacount-8020.ts --port=18020 --verbose
 *
 * The protocol is implemented from the TSI Technical Addendum and the
 * canonical settings burst (see `adapter/wire-protocol.md`).
 */

import { WebSocketServer, type WebSocket } from 'ws';

interface Options {
  port: number;
  verbose: boolean;
}

const DEFAULT_PORT = 18020;

function parseArgs(argv: string[]): Options {
  let port = DEFAULT_PORT;
  let verbose = false;
  for (const arg of argv) {
    const m = /^--port=(\d+)$/.exec(arg);
    if (m) {
      port = parseInt(m[1], 10);
      continue;
    }
    if (arg === '--verbose' || arg === '-v') {
      verbose = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('usage: portacount-8020 [--port=N] [--verbose]');
      process.exit(0);
    }
  }
  return { port, verbose };
}

const SETTINGS_BURST = [
  'STPA 00004',
  'STA  00005',
  'STPM 00011',
  'STM0100040',
  'STM0200040',
  'STM0300040',
  'STM0400040',
  'STM0500040',
  'STM0600040',
  'STM0700040',
  'STM0800040',
  'STM0900040',
  'STM1000040',
  'STM1100040',
  'STM1200040',
  'STM1300040',
  'SP 0100100',
  'SP 0200250',
  'SP 0300500',
  'SP 0401000',
  'SP 0501250',
  'SP 0601667',
  'SP 0702000',
  'SP 0804000',
  'SP 0905000',
  'SP 1006667',
  'SP 1110000',
  'SP 1200000',
  'SS   17754',
  'SR   00722',
  'SD   00519',
];

const VOLTAGE_BURST = ['CS191', 'CB483', 'CT236', 'CC065', 'CL614', 'CP255', 'CD068'];

const BANNER = [
  'PORTACOUNT PLUS PROM V1.7',
  'COPYRIGHT(c)1992 TSI INC',
  'ALL RIGHTS RESERVED',
  'Serial Number 17754',
  'FF pass level = 100',
  'No. of exers  = 4',
  'Ambt purge   = 4 sec.',
  'Ambt sample  = 5 sec.',
  'Mask purge  = 11 sec.',
  'Mask sample 1 = 40 sec.',
  'Mask sample 2 = 40 sec.',
  'Mask sample 3 = 40 sec.',
  'Mask sample 4 = 40 sec.',
  'DIP switch  = 10111111',
];

type SampleSource = 'ambient' | 'mask';

class SimDevice {
  externalControl = false;
  dataTxEnabled = false;
  sampleSource: SampleSource = 'ambient';
  /** When data transmission is enabled in external mode, the device
   * streams one concentration per second. Internal mode emits the
   * `Conc.` form roughly every 2 seconds. */
  private tickHandle: NodeJS.Timeout | null = null;
  private targetCount = 1000;
  private varianceFraction = 0.1;
  private tickCounter = 0;
  private fitTestTimer: NodeJS.Timeout | null = null;

  constructor(
    private send: (line: string) => void,
    private verbose: boolean,
  ) {
    this.startTick();
    // Boot banner — emitted on connect, mimicking power-on.
    for (const b of BANNER) this.send(b);
  }

  shutdown(): void {
    if (this.tickHandle !== null) clearInterval(this.tickHandle);
    this.tickHandle = null;
    if (this.fitTestTimer !== null) clearTimeout(this.fitTestTimer);
    this.fitTestTimer = null;
  }

  private startTick(): void {
    this.tickHandle = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    this.tickCounter += 1;
    if (this.externalControl) {
      if (!this.dataTxEnabled) return;
      const conc = this.currentConcentration();
      // External-mode form: zero-padded fixed-point.
      this.send(formatExternalConcentration(conc));
      return;
    }
    // Internal mode: emit `Conc.` once every 2 ticks.
    if (this.tickCounter % 2 === 0) {
      const conc = this.currentConcentration();
      this.send(`Conc.   ${conc.toFixed(2).padStart(8)} #/cc`);
    }
  }

  private currentConcentration(): number {
    // Mask-side reads ~5% of ambient when the seal is good.
    const base = this.sampleSource === 'ambient' ? this.targetCount : this.targetCount * 0.05;
    const jitter = base * this.varianceFraction * (Math.random() - 0.5) * 2;
    return Math.max(0, base + jitter);
  }

  /** Handle one inbound command from the host. */
  handleCommand(cmd: string): void {
    if (this.verbose) console.log(`[sim rx] ${cmd}`);
    if (cmd === 'J') {
      if (this.externalControl) {
        this.send('EJ');
      } else {
        this.externalControl = true;
        this.send('OK');
      }
      return;
    }
    if (cmd === 'G') {
      this.externalControl = false;
      this.dataTxEnabled = false;
      this.send('G');
      return;
    }
    if (cmd === 'Y') {
      this.send('Y');
      // In a real device, power would drop. We just stop ticking.
      this.shutdown();
      return;
    }
    if (cmd === 'ZE') {
      this.dataTxEnabled = true;
      this.send('ZE');
      return;
    }
    if (cmd === 'ZD') {
      this.dataTxEnabled = false;
      this.send('ZD');
      return;
    }
    if (cmd === 'VN') {
      this.sampleSource = 'ambient';
      this.send('VN');
      return;
    }
    if (cmd === 'VF') {
      this.sampleSource = 'mask';
      this.send('VF');
      return;
    }
    if (cmd === 'R') {
      this.send('RGG');
      return;
    }
    if (cmd === 'C') {
      for (const v of VOLTAGE_BURST) this.send(v);
      return;
    }
    if (cmd === 'S') {
      // Echo S then dump the settings burst.
      this.send('S');
      for (const line of SETTINGS_BURST) this.send(line);
      return;
    }
    if (cmd === 'Q') {
      this.send('QN');
      return;
    }
    if (/^B\d\d$/.test(cmd)) {
      this.send(cmd);
      return;
    }
    if (/^P[TP]/.test(cmd)) {
      // Configuration write — for the simulator, just echo as ack.
      this.send(cmd);
      return;
    }
    if (cmd === 'SIM_RUN_FITTEST') {
      // Simulator-only convenience: kick off an internal-mode fit
      // test sequence so the runner has something to chew on.
      this.runFitTest();
      return;
    }
    // Unknown command — emit an error response.
    this.send(`E${cmd}`);
  }

  private runFitTest(): void {
    if (this.fitTestTimer) return;
    const passLevel = 100;
    const exercises: Array<{ ambient: number; mask: number; ff: number; result: string }> = [
      { ambient: 2290, mask: 5.62, ff: 352, result: 'PASS' },
      { ambient: 2210, mask: 8.4, ff: 263, result: 'PASS' },
      { ambient: 2300, mask: 6.1, ff: 377, result: 'PASS' },
      { ambient: 2280, mask: 7.2, ff: 317, result: 'PASS' },
    ];
    this.send(`NEW TEST PASS = ${pad3(passLevel)}`);
    let idx = 0;
    // Each exercise: a short purge stream (4× ambient Conc.), a short
    // mask stream (4× mask-side Conc.), then the summary triple
    // (Ambient / Mask / FF). Cadence is 150 ms per Conc. line so the UI
    // sees motion; total per-exercise ~1.2 s.
    const STEP_MS = 150;
    const step = () => {
      if (idx >= exercises.length) {
        const overall = Math.round(harmonicMean(exercises.map((e) => e.ff)));
        const result = overall >= passLevel ? 'PASS' : 'FAIL';
        this.send(`Overall FF   ${overall} ${result}`);
        this.fitTestTimer = null;
        return;
      }
      const e = exercises[idx]!;
      const ambJittered = (base: number) => {
        const jitter = base * 0.05 * (Math.random() - 0.5) * 2;
        return Math.max(0, base + jitter);
      };
      // Ambient purge phase.
      const ambStream = [0, 1, 2, 3].map(() => ambJittered(e.ambient));
      // Mask sample phase.
      const maskStream = [0, 1, 2, 3].map(() => ambJittered(e.mask));
      const lines: Array<() => void> = [];
      for (const c of ambStream) lines.push(() => this.send(formatConc(c)));
      for (const c of maskStream) lines.push(() => this.send(formatConc(c)));
      lines.push(() => this.send(`Ambient   ${e.ambient} #/cc`));
      lines.push(() => this.send(`Mask    ${e.mask} #/cc`));
      lines.push(() => this.send(`FF  ${idx + 1}    ${e.ff} ${e.result}`));
      idx += 1;
      const runNext = (i: number) => {
        if (i >= lines.length) {
          this.fitTestTimer = setTimeout(step, STEP_MS);
          return;
        }
        lines[i]!();
        this.fitTestTimer = setTimeout(() => runNext(i + 1), STEP_MS);
      };
      runNext(0);
    };
    this.fitTestTimer = setTimeout(step, 100);
  }
}

function pad3(n: number): string {
  return n.toString().padStart(3, ' ');
}

function harmonicMean(xs: number[]): number {
  const inv = xs.reduce((a, x) => a + 1 / x, 0);
  return xs.length / inv;
}

function formatExternalConcentration(c: number): string {
  // 6.2 width, zero-padded, e.g. "006408.45"
  const fixed = c.toFixed(2);
  return fixed.padStart(9, '0');
}

function formatConc(c: number): string {
  return `Conc.   ${c.toFixed(2).padStart(8)} #/cc`;
}

function chunkCommands(buf: string): { commands: string[]; rest: string } {
  const commands: string[] = [];
  let rest = buf;
  while (true) {
    const idx = rest.indexOf('\r');
    if (idx === -1) break;
    const cmd = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (cmd.length > 0) commands.push(cmd);
  }
  return { commands, rest };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const wss = new WebSocketServer({ port: opts.port });
  console.log(`PortaCount 8020 simulator listening on ws://localhost:${opts.port}`);

  wss.on('connection', (socket: WebSocket) => {
    let buffer = '';
    console.log('[sim] client connected');
    const send = (line: string) => {
      const wire = line + '\r';
      socket.send(wire);
      if (opts.verbose) console.log(`[sim tx] ${line}`);
    };
    const device = new SimDevice(send, opts.verbose);

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const text =
        typeof data === 'string'
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data as Buffer[]).toString('utf8')
            : Buffer.from(data as ArrayBuffer).toString('utf8');
      buffer += text;
      const { commands, rest } = chunkCommands(buffer);
      buffer = rest;
      for (const cmd of commands) device.handleCommand(cmd);
    });

    socket.on('close', () => {
      console.log('[sim] client disconnected');
      device.shutdown();
    });
  });
}

main();
