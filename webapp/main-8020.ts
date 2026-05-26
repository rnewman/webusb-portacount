/**
 * PortaCount 8020 panel.
 *
 * Self-contained UI for the live readings + fit-test runner, but
 * **no connect/disconnect UI of its own** — that's owned by the
 * top-level connection pill in main.ts via a device picker. This
 * module exposes a controller object so main.ts can drive connect
 * and disconnect imperatively.
 *
 * Two transports are supported via the controller's `connect()` arg:
 *  - "serial" → real RS-232 cable, via Web Serial.
 *  - "simulator" → WebSocket to the standalone simulator process
 *                  (see `simulator/portacount-8020.ts`).
 */

import {
  Portacount8020,
  WebSerialByteStream,
  WebSocketByteStream,
  runHostDrivenFitTest,
  DEFAULT_CYCLE,
  FitTestAbortedError8020,
  type ByteStream,
  type FitTestResult8020,
  type FitTestPhaseInfo,
  type Portacount8020State,
} from 'webusb-portacount';

interface SerialPortChooser {
  requestPort: (opts?: { filters?: unknown[] }) => Promise<unknown>;
}

const SIM_DEFAULT_URL = 'ws://localhost:18020';

// Common USB-serial adapter vendor IDs. The Web Serial port chooser
// uses these to narrow the list to plausible PortaCount cables and
// hide things like the Mac's Bluetooth-Incoming-Port and debug TTYs.
const USB_SERIAL_FILTERS = [
  { usbVendorId: 0x0403 }, // FTDI (e.g. FT232R — the cable in our golden capture)
  { usbVendorId: 0x067b }, // Prolific PL2303
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x1a86 }, // WCH CH340 / CH341
];

export type TransportKind = 'serial' | 'simulator';

export interface Pc8020ConnectOptions {
  transport: TransportKind;
  /** Serial baud rate (ignored for simulator). */
  baudRate?: number;
  /** WebSocket URL (ignored for serial). */
  simUrl?: string;
}

export interface Pc8020Controller {
  /** Open the transport and connect a Portacount8020 with sane
   * defaults (J + ZE + R + S). Throws on failure (also tears down
   * the byte stream so the port doesn't stay locked). */
  connect(opts: Pc8020ConnectOptions): Promise<void>;
  /** Disconnect cleanly. Safe to call from any state. */
  disconnect(): Promise<void>;
  /** Connection state: 'idle' | 'connecting' | 'ready' | 'closing' | 'closed'. */
  readonly connection: string;
  /** Subscribe to log lines (also written to the panel's line log). */
  onLog(cb: (line: string) => void): () => void;
}

interface Pane {
  root: HTMLElement;
  runTestBtn: HTMLButtonElement;
  abortTestBtn: HTMLButtonElement;
  quickModeChk: HTMLInputElement;
  connEl: HTMLElement;
  concentrationEl: HTMLElement;
  controlSourceEl: HTMLElement;
  sampleSourceEl: HTMLElement;
  serialNumberEl: HTMLElement;
  phaseEl: HTMLElement;
  resultsEl: HTMLElement;
}

export function mount8020Panel(root: HTMLElement): Pc8020Controller {
  root.innerHTML = TEMPLATE;
  const pane = bindPane(root);
  let client: Portacount8020 | null = null;
  let stream: ByteStream | null = null;
  let testAbort: AbortController | null = null;
  const results: FitTestResult8020[] = [];
  const logSubscribers = new Set<(line: string) => void>();

  const log = (msg: string) => {
    // No local pane log: the main page's Event Log subscribes via
    // controller.onLog() and renders everything there.
    for (const cb of logSubscribers) {
      try { cb(msg); } catch { /* swallow */ }
    }
  };

  const onConnectionChange = (s: string) => {
    pane.connEl.textContent = s;
    pane.connEl.dataset.state = s;
    pane.runTestBtn.disabled = s !== 'ready' || testAbort !== null;
  };

  const onState = (st: Portacount8020State) => {
    pane.concentrationEl.textContent =
      st.lastConcentration === null ? '—' : st.lastConcentration.toFixed(2);
    pane.controlSourceEl.textContent = st.controlSource;
    pane.sampleSourceEl.textContent = st.sampleSource;
    pane.serialNumberEl.textContent = st.settings.serialNumber ?? '—';
  };

  pane.runTestBtn.addEventListener('click', async () => {
    if (!client || testAbort !== null) return;
    const quick = pane.quickModeChk.checked;
    const cycle = quick
      ? { ambientPurgeSec: 2, ambientSampleSec: 3, maskPurgeSec: 2, maskSampleSec: 5 }
      : DEFAULT_CYCLE;
    testAbort = new AbortController();
    pane.runTestBtn.disabled = true;
    pane.abortTestBtn.disabled = false;
    pane.phaseEl.textContent = 'starting…';
    log(quick ? 'running fit test (quick mode)…' : 'running fit test (real timing)…');

    try {
      const result = await runHostDrivenFitTest(
        client,
        {
          exercises: 1,
          ...cycle,
          passLevel: 100,
          signal: testAbort.signal,
        },
        {
          onPhaseStart: (info: FitTestPhaseInfo) => {
            pane.phaseEl.textContent = `exercise ${info.exerciseNumber} · ${info.phase} (${(info.durationMs / 1000).toFixed(0)}s, ${info.collecting ? 'collecting' : 'discarding'})`;
            log(
              `phase: exercise ${info.exerciseNumber} · ${info.phase} (${(info.durationMs / 1000).toFixed(0)}s)`,
            );
          },
          onPhaseEnd: (info, samples) => {
            if (info.collecting && samples.length > 0) {
              const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
              log(`  → ${samples.length} samples, mean=${mean.toFixed(2)} #/cc`);
            }
          },
          onExerciseCompleted: (r) =>
            log(`exercise ${r.exerciseNumber}: FF=${r.fitFactor.toFixed(1)} ${r.result}`),
        },
      );
      results.unshift(result);
      renderResults();
      pane.phaseEl.textContent = `done — overall FF=${result.overallFitFactor?.toFixed(0) ?? '—'} ${result.overallResult ?? ''}`;
      log(
        `result: overall FF=${result.overallFitFactor?.toFixed(0) ?? '—'} (${result.overallResult ?? '—'}, ${result.exercises.length} exercise)`,
      );
    } catch (err) {
      if (err instanceof FitTestAbortedError8020) {
        log('test aborted.');
        pane.phaseEl.textContent = 'aborted';
      } else {
        log(`fit test failed: ${(err as Error).message}`);
        pane.phaseEl.textContent = `failed: ${(err as Error).message}`;
      }
    } finally {
      testAbort = null;
      pane.runTestBtn.disabled = client?.connection !== 'ready';
      pane.abortTestBtn.disabled = true;
    }
  });

  pane.abortTestBtn.addEventListener('click', () => {
    testAbort?.abort(new Error('aborted by user'));
  });

  const renderResults = () => {
    pane.resultsEl.innerHTML = '';
    for (const r of results) {
      const li = document.createElement('li');
      li.className = 'result-card';
      const time = new Date(r.endedAt).toLocaleTimeString();
      const overall =
        r.overallFitFactor === null
          ? '—'
          : `${r.overallFitFactor.toFixed(0)} ${r.overallResult ?? ''}`;
      const perEx = r.exercises
        .map((e) => `#${e.exerciseNumber}=${e.fitFactor.toFixed(0)}${e.result === 'PASS' ? '✓' : '✗'}`)
        .join(' ');
      li.textContent = `[${time}] overall=${overall} · ${perEx}`;
      pane.resultsEl.appendChild(li);
    }
  };

  async function teardown(): Promise<void> {
    testAbort?.abort(new Error('disconnect'));
    testAbort = null;
    if (client) {
      try { await client.disconnect(); } catch (err) { log(`disconnect error: ${(err as Error).message}`); }
    }
    client = null;
    stream = null;
    pane.runTestBtn.disabled = true;
    pane.abortTestBtn.disabled = true;
    pane.phaseEl.textContent = '—';
    pane.concentrationEl.textContent = '—';
    pane.controlSourceEl.textContent = '—';
    pane.sampleSourceEl.textContent = '—';
    pane.serialNumberEl.textContent = '—';
    pane.connEl.textContent = 'idle';
    pane.connEl.dataset.state = 'idle';
  }

  const controller: Pc8020Controller = {
    async connect(opts) {
      if (client) throw new Error('8020 already connected');
      const baud = opts.baudRate ?? 1200;
      const url = opts.simUrl ?? SIM_DEFAULT_URL;
      stream =
        opts.transport === 'simulator'
          ? await openSimStream(url, log)
          : await openSerialStream(baud, log);

      client = new Portacount8020({ log });
      client.onConnection(onConnectionChange);
      client.onState(onState);
      client.onLine((line) => log(`< ${line}`));

      log(`connecting via ${stream.info?.label ?? '(unknown)'}…`);
      try {
        await client.connect(stream, {
          enableExternalControl: true,
          enableDataTransmission: true,
          requestRuntimeStatus: true,
          requestSettings: true,
        });
        log('connected.');
      } catch (err) {
        log(`connect failed: ${(err as Error).message}`);
        await teardown();
        throw err;
      }
    },
    async disconnect() {
      log('disconnecting…');
      await teardown();
      log('disconnected.');
    },
    get connection() {
      return client?.connection ?? 'idle';
    },
    onLog(cb) {
      logSubscribers.add(cb);
      return () => logSubscribers.delete(cb);
    },
  };
  return controller;
}

async function openSerialStream(baudRate: number, log: (msg: string) => void): Promise<ByteStream> {
  const nav = navigator as unknown as { serial?: SerialPortChooser };
  if (!nav.serial) {
    throw new Error('Web Serial not available — use Chromium 89+ or Firefox 132+.');
  }
  const port = (await nav.serial.requestPort({
    filters: USB_SERIAL_FILTERS,
  })) as unknown as ConstructorParameters<typeof WebSerialByteStream>[0];
  const stream = new WebSerialByteStream(port, {
    openParams: { baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
    log,
  });
  await stream.ready();
  return stream;
}

async function openSimStream(url: string, log: (msg: string) => void): Promise<ByteStream> {
  const stream = new WebSocketByteStream({ url, log });
  await stream.ready();
  return stream;
}

function bindPane(root: HTMLElement): Pane {
  const get = <T extends HTMLElement>(sel: string): T => {
    const node = root.querySelector(sel);
    if (!node) throw new Error(`8020 panel: missing ${sel}`);
    return node as T;
  };
  return {
    root,
    runTestBtn: get<HTMLButtonElement>('[data-id="run-test"]'),
    abortTestBtn: get<HTMLButtonElement>('[data-id="abort-test"]'),
    quickModeChk: get<HTMLInputElement>('[data-id="quick-mode"]'),
    connEl: get<HTMLElement>('[data-id="conn"]'),
    concentrationEl: get<HTMLElement>('[data-id="concentration"]'),
    controlSourceEl: get<HTMLElement>('[data-id="control-source"]'),
    sampleSourceEl: get<HTMLElement>('[data-id="sample-source"]'),
    serialNumberEl: get<HTMLElement>('[data-id="serial-number"]'),
    phaseEl: get<HTMLElement>('[data-id="phase"]'),
    resultsEl: get<HTMLElement>('[data-id="results"]'),
  };
}

const TEMPLATE = `
<div class="pc8020-panel">
  <div class="pc8020-readings">
    <div><span class="label">Connection</span><span data-id="conn" data-state="idle">idle</span></div>
    <div><span class="label">Control</span><span data-id="control-source">—</span></div>
    <div><span class="label">Valve</span><span data-id="sample-source">—</span></div>
    <div><span class="label">Concentration #/cc</span><span data-id="concentration">—</span></div>
    <div><span class="label">Device S/N</span><span data-id="serial-number">—</span></div>
    <div><span class="label">Phase</span><span data-id="phase">—</span></div>
  </div>

  <div class="pc8020-runner">
    <div class="pc8020-actions">
      <button data-id="run-test" disabled>Run fit test</button>
      <button data-id="abort-test" disabled>Abort</button>
      <label style="margin-left:1rem"><input data-id="quick-mode" type="checkbox"> Quick mode (compressed timing)</label>
    </div>
    <div>
      <strong>Recent results:</strong>
      <ul data-id="results"></ul>
    </div>
  </div>

  <!-- Serial line log is piped into the main Event Log (left column)
       via the controller's onLog() subscription; no duplicate here. -->
</div>
`;
