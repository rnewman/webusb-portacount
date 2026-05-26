/**
 * PortaCount 8020 connect/live/fit-test panel.
 *
 * Standalone module — wires the 8020 client to its own DOM elements
 * inside the "8020 (serial)" tab. Does not (yet) share storage with
 * the 8030 flow; we are still discovering what's truly common.
 *
 * Two transports are supported:
 *  - "Web Serial" → real RS-232 cable plugged into the 8020.
 *  - "Simulator"  → WebSocket to the standalone simulator process
 *                   (see `simulator/portacount-8020.ts`).
 */

import {
  Portacount8020,
  WebSerialByteStream,
  WebSocketByteStream,
  FitTestRunner8020,
  type ByteStream,
  type FitTestResult8020,
  type Portacount8020State,
} from 'webusb-portacount';

interface SerialPortChooser {
  requestPort: (opts?: { filters?: unknown[] }) => Promise<unknown>;
}

const SIM_DEFAULT_URL = 'ws://localhost:18020';

interface Pane {
  root: HTMLElement;
  connectBtn: HTMLButtonElement;
  disconnectBtn: HTMLButtonElement;
  transportSel: HTMLSelectElement;
  simUrlInput: HTMLInputElement;
  baudInput: HTMLInputElement;
  externalControlChk: HTMLInputElement;
  dataTxChk: HTMLInputElement;
  enableRunnerBtn: HTMLButtonElement;
  simRunFittestBtn: HTMLButtonElement;
  stateEl: HTMLElement;
  connEl: HTMLElement;
  concentrationEl: HTMLElement;
  controlSourceEl: HTMLElement;
  sampleSourceEl: HTMLElement;
  serialNumberEl: HTMLElement;
  passLevelEl: HTMLElement;
  liveExercisesEl: HTMLElement;
  resultsEl: HTMLElement;
  logEl: HTMLElement;
}

export function mount8020Panel(root: HTMLElement): void {
  root.innerHTML = TEMPLATE;
  const pane = bindPane(root);
  let client: Portacount8020 | null = null;
  let stream: ByteStream | null = null;
  let runner: FitTestRunner8020 | null = null;
  const results: FitTestResult8020[] = [];

  const log = (msg: string) => appendLog(pane.logEl, msg);

  const onConnectionChange = (s: string) => {
    pane.connEl.textContent = s;
    pane.connEl.dataset.state = s;
    pane.disconnectBtn.disabled = s === 'idle' || s === 'closed' || s === 'closing';
    pane.connectBtn.disabled = s === 'connecting' || s === 'ready' || s === 'closing';
    pane.enableRunnerBtn.disabled = s !== 'ready';
    pane.simRunFittestBtn.disabled = s !== 'ready' || pane.transportSel.value !== 'simulator';
  };

  const onState = (st: Portacount8020State) => {
    pane.concentrationEl.textContent =
      st.lastConcentration === null ? '—' : st.lastConcentration.toFixed(2);
    pane.controlSourceEl.textContent = st.controlSource;
    pane.sampleSourceEl.textContent = st.sampleSource;
    pane.serialNumberEl.textContent = st.settings.serialNumber ?? '—';
    pane.passLevelEl.textContent =
      st.fitTest?.passLevel != null ? String(st.fitTest.passLevel) : '—';
    pane.liveExercisesEl.innerHTML = '';
    if (st.fitTest) {
      for (const ex of st.fitTest.exercises) {
        const li = document.createElement('li');
        li.textContent = `#${ex.exerciseNumber}: FF=${ex.fitFactor} ${ex.result}`;
        pane.liveExercisesEl.appendChild(li);
      }
    }
  };

  pane.transportSel.addEventListener('change', () => {
    const isSim = pane.transportSel.value === 'simulator';
    pane.simUrlInput.disabled = !isSim;
    pane.baudInput.disabled = isSim;
  });
  pane.transportSel.dispatchEvent(new Event('change'));

  pane.connectBtn.addEventListener('click', async () => {
    if (client) return;
    pane.connectBtn.disabled = true;
    try {
      const transport = pane.transportSel.value;
      stream = transport === 'simulator'
        ? await openSimStream(pane.simUrlInput.value || SIM_DEFAULT_URL, log)
        : await openSerialStream(parseInt(pane.baudInput.value, 10) || 1200, log);

      client = new Portacount8020({ log });
      client.onConnection(onConnectionChange);
      client.onState(onState);
      client.onLine((line) => log(`< ${line}`));

      log(`connecting via ${stream.info?.label ?? '(unknown)'}…`);
      // External control is a hard prerequisite for ZE/R/S/etc. on
      // real hardware — without it the device ignores those commands
      // and the queue times out. Auto-imply it if the user requested
      // anything that needs it.
      const needsExternal =
        pane.dataTxChk.checked || pane.externalControlChk.checked;
      if (pane.dataTxChk.checked && !pane.externalControlChk.checked) {
        log('(auto-enabling external control — required for continuous data)');
      }
      await client.connect(stream, {
        enableExternalControl: needsExternal,
        enableDataTransmission: pane.dataTxChk.checked,
        requestRuntimeStatus: true,
        requestSettings: true,
      });
      log('connected.');
    } catch (err) {
      log(`connect failed: ${(err as Error).message}`);
      await teardown();
    }
  });

  pane.disconnectBtn.addEventListener('click', async () => {
    pane.disconnectBtn.disabled = true;
    log('disconnecting…');
    await teardown();
    log('disconnected.');
  });

  pane.enableRunnerBtn.addEventListener('click', () => {
    if (!client) return;
    if (runner) {
      runner.stop();
      runner = null;
      pane.enableRunnerBtn.textContent = 'Watch for fit tests';
      log('runner: stopped watching.');
      return;
    }
    runner = new FitTestRunner8020(client, {
      onNewTest: (passLevel) => log(`runner: NEW TEST (pass=${passLevel})`),
      onExerciseCompleted: (r) =>
        log(`runner: FF ${r.exerciseNumber} = ${r.fitFactor} ${r.result}`),
      onResult: (r) => {
        log(
          `runner: result (${r.terminalReason}) overall=${r.overallFitFactor ?? '?'} ${
            r.overallResult ?? ''
          }`,
        );
        results.unshift(r);
        renderResults();
      },
      onLowParticleWarning: () => log('runner: LOW PARTICLE COUNT warning'),
    });
    runner.start();
    pane.enableRunnerBtn.textContent = 'Stop watching';
    log('runner: watching for fit tests on the line stream.');
  });

  pane.simRunFittestBtn.addEventListener('click', async () => {
    if (!client) return;
    try {
      await client.command('SIM_RUN_FITTEST', { ackPattern: /^NEW TEST PASS/, timeoutMs: 5000 });
    } catch (err) {
      log(`sim fit-test trigger failed: ${(err as Error).message}`);
    }
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
      li.textContent = `[${time}] pass=${r.passLevel ?? '—'} overall=${overall} (${r.terminalReason}, ${r.exercises.length} exercises)`;
      pane.resultsEl.appendChild(li);
    }
  };

  async function teardown(): Promise<void> {
    runner?.stop();
    runner = null;
    if (client) {
      try { await client.disconnect(); } catch (err) { log(`disconnect error: ${(err as Error).message}`); }
    }
    client = null;
    stream = null;
    pane.connectBtn.disabled = false;
    pane.disconnectBtn.disabled = true;
    pane.enableRunnerBtn.disabled = true;
    pane.enableRunnerBtn.textContent = 'Watch for fit tests';
    pane.simRunFittestBtn.disabled = true;
    pane.concentrationEl.textContent = '—';
    pane.controlSourceEl.textContent = '—';
    pane.sampleSourceEl.textContent = '—';
    pane.serialNumberEl.textContent = '—';
    pane.passLevelEl.textContent = '—';
    pane.liveExercisesEl.innerHTML = '';
    pane.connEl.textContent = 'idle';
    pane.connEl.dataset.state = 'idle';
  }
}

async function openSerialStream(baudRate: number, log: (msg: string) => void): Promise<ByteStream> {
  const nav = navigator as unknown as { serial?: SerialPortChooser };
  if (!nav.serial) {
    throw new Error('Web Serial not available — use Chromium 89+ or Firefox 132+.');
  }
  const port = (await nav.serial.requestPort({})) as unknown as ConstructorParameters<typeof WebSerialByteStream>[0];
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
    connectBtn: get<HTMLButtonElement>('[data-id="connect"]'),
    disconnectBtn: get<HTMLButtonElement>('[data-id="disconnect"]'),
    transportSel: get<HTMLSelectElement>('[data-id="transport"]'),
    simUrlInput: get<HTMLInputElement>('[data-id="sim-url"]'),
    baudInput: get<HTMLInputElement>('[data-id="baud"]'),
    externalControlChk: get<HTMLInputElement>('[data-id="external-control"]'),
    dataTxChk: get<HTMLInputElement>('[data-id="data-tx"]'),
    enableRunnerBtn: get<HTMLButtonElement>('[data-id="enable-runner"]'),
    simRunFittestBtn: get<HTMLButtonElement>('[data-id="sim-run"]'),
    stateEl: get<HTMLElement>('[data-id="state"]'),
    connEl: get<HTMLElement>('[data-id="conn"]'),
    concentrationEl: get<HTMLElement>('[data-id="concentration"]'),
    controlSourceEl: get<HTMLElement>('[data-id="control-source"]'),
    sampleSourceEl: get<HTMLElement>('[data-id="sample-source"]'),
    serialNumberEl: get<HTMLElement>('[data-id="serial-number"]'),
    passLevelEl: get<HTMLElement>('[data-id="pass-level"]'),
    liveExercisesEl: get<HTMLElement>('[data-id="live-exercises"]'),
    resultsEl: get<HTMLElement>('[data-id="results"]'),
    logEl: get<HTMLElement>('[data-id="log"]'),
  };
}

function appendLog(el: HTMLElement, msg: string): void {
  const line = document.createElement('div');
  line.className = 'log-line';
  const ts = new Date().toISOString().substring(11, 23);
  line.textContent = `[${ts}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

const TEMPLATE = `
<div class="pc8020-panel">
  <div class="pc8020-controls">
    <label>
      Transport:
      <select data-id="transport">
        <option value="serial">Web Serial (real 8020)</option>
        <option value="simulator">Simulator (WebSocket)</option>
      </select>
    </label>
    <label>
      Baud:
      <input data-id="baud" type="number" value="1200" min="300" max="115200" style="width:6em">
    </label>
    <label>
      Sim URL:
      <input data-id="sim-url" type="text" value="${SIM_DEFAULT_URL}" style="width:18em" disabled>
    </label>
    <label><input data-id="external-control" type="checkbox"> Seize external control on connect</label>
    <label><input data-id="data-tx" type="checkbox"> Enable continuous data on connect</label>
    <div class="pc8020-actions">
      <button data-id="connect">Connect</button>
      <button data-id="disconnect" disabled>Disconnect</button>
    </div>
  </div>

  <div class="pc8020-readings">
    <div><span class="label">Connection</span><span data-id="conn" data-state="idle">idle</span></div>
    <div><span class="label">Control</span><span data-id="control-source">—</span></div>
    <div><span class="label">Valve</span><span data-id="sample-source">—</span></div>
    <div><span class="label">Concentration #/cc</span><span data-id="concentration">—</span></div>
    <div><span class="label">Device S/N</span><span data-id="serial-number">—</span></div>
    <div><span class="label">Pass level</span><span data-id="pass-level">—</span></div>
  </div>

  <div class="pc8020-runner">
    <div class="pc8020-actions">
      <button data-id="enable-runner" disabled>Watch for fit tests</button>
      <button data-id="sim-run" disabled>Trigger simulator fit test</button>
    </div>
    <div>
      <strong>Live exercises:</strong>
      <ul data-id="live-exercises"></ul>
    </div>
    <div>
      <strong>Recent results:</strong>
      <ul data-id="results"></ul>
    </div>
    <div style="display:none"><span data-id="state"></span></div>
  </div>

  <div class="pc8020-log">
    <strong>Line log</strong>
    <div data-id="log" class="event-log"></div>
  </div>
</div>
`;
