import {
  LwipStack,
  RndisWireLayer,
  Cmd,
  Portacount,
  Portacount8020,
  WebSerialByteStream,
  WebSocketByteStream,
  parseResponse,
  type ByteStream,
  type IpOctets,
  type DeviceInfo,
} from 'webusb-portacount';
import createLwipModule from 'webusb-portacount/wasm';
import wasmUrl from 'webusb-portacount/wasm/lwip.wasm?url';
import { openSessionStore, type SampleRecord, type SessionStore } from './session-store';
import { SessionPanel, type ActiveCardHandle } from './session-panel';
import { openFitTestStore, type FitTestStore } from './fittest-store';
import { FitTestUi } from './fittest-ui';
import { FitTestHistoryPanel } from './fittest-history-panel';

const DHCP_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1000;

const eventLogEl = el<HTMLDivElement>('event-log');
const connectBtn = el<HTMLButtonElement>('connect-btn');
const disconnectBtn = el<HTMLButtonElement>('disconnect-btn');
const startBtn = el<HTMLButtonElement>('start-btn');
const stopBtn = el<HTMLButtonElement>('stop-btn');
const xmlTraceToggle = el<HTMLInputElement>('xml-trace-toggle');
const sessionListEl = el<HTMLDivElement>('session-list');
const connPill = el<HTMLElement>('connection-pill');
const connSummary = el<HTMLElement>('conn-summary');
const connDetails = el<HTMLDetailsElement>('conn-details');

// Collapse the debug gutter by default on narrow screens. Use
// matchMedia rather than a media query in CSS so the user's manual
// expand/collapse choice persists across viewport changes (we only
// flip the initial state).
{
  const gutter = document.getElementById('debug-gutter-details') as HTMLDetailsElement | null;
  if (gutter && window.matchMedia('(max-width: 900px)').matches) {
    gutter.open = false;
  }
}

// Tab switching — two tabs share the right column; flipping is just a
// CSS class + `hidden` attribute swap.
for (const tabBtn of document.querySelectorAll<HTMLButtonElement>('.tab')) {
  tabBtn.addEventListener('click', () => {
    const which = tabBtn.dataset.tab;
    if (!which) return;
    for (const b of document.querySelectorAll<HTMLButtonElement>('.tab')) {
      const on = b.dataset.tab === which;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
    for (const p of document.querySelectorAll<HTMLElement>('.tab-panel')) {
      const on = p.dataset.tabPanel === which;
      p.classList.toggle('active', on);
      p.hidden = !on;
    }
  });
}

function setConnState(state: 'disconnected' | 'connecting' | 'connected', summary: string): void {
  connPill.classList.remove('disconnected', 'connecting', 'connected');
  connPill.classList.add(state);
  connSummary.textContent = summary;
}

interface Session {
  wire: RndisWireLayer;
  stack: LwipStack;
  pc: Portacount;
  /** The USBDevice we opened, kept so the navigator.usb disconnect
   * listener can match unplug events against the active session. */
  device: USBDevice;
  pollHandle: ReturnType<typeof setInterval> | null;
  deviceInfo: DeviceInfo;
  /** Live card + IDB session id, populated while sampling. */
  active: {
    card: ActiveCardHandle;
    sessionId: number;
    startedAt: number;
  } | null;
}

let session: Session | null = null;
let sessionStore: SessionStore | null = null;
let sessionPanel: SessionPanel | null = null;
let fittestStore: FitTestStore | null = null;
let fittestUi: FitTestUi | null = null;
let fittestHistory: FitTestHistoryPanel | null = null;

// Open IndexedDB and populate the panel from history. Only publish
// `sessionPanel` after `reloadFromStore` completes — otherwise a fast
// user clicking Start sampling before history loads would have their
// active card wiped by reloadFromStore's replaceChildren.
void (async () => {
  try {
    sessionStore = await openSessionStore();
    const panel = new SessionPanel(sessionListEl, sessionStore);
    await panel.reloadFromStore();
    sessionPanel = panel;
  } catch (err) {
    log(`session store init failed: ${(err as Error).message}`);
  }
})();

// ----- Device picker (top connection pill) -----
//
// Single Connect button drives the right transport based on which
// device segment is selected. The Test Runs / Sampling tabs are
// device-agnostic (FitTestUi dispatches based on its deviceMode).

type DeviceMode = '8030-usb' | '8020-serial' | '8020-sim';
let deviceMode: DeviceMode = '8030-usb';
/** Live 8020 client/stream, populated while in 8020 (serial or sim) mode. */
let session8020: { client: Portacount8020; stream: ByteStream } | null = null;
/** Active 8020 sampling session — null when not sampling. */
let active8020Sampling: {
  sessionId: number;
  startedAt: number;
  card: ActiveCardHandle;
  unsubscribe: () => void;
} | null = null;

// Common USB-serial adapter vendor IDs for the Web Serial port chooser.
// Used in 8020-serial mode so the dialog only shows plausible cables.
const USB_SERIAL_FILTERS = [
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x067b }, // Prolific PL2303
  { usbVendorId: 0x10c4 }, // Silicon Labs CP210x
  { usbVendorId: 0x1a86 }, // WCH CH340 / CH341
];

const devicePickerEls = Array.from(
  document.querySelectorAll<HTMLButtonElement>('.device-opt'),
);
function setDeviceMode(next: DeviceMode): void {
  deviceMode = next;
  for (const btn of devicePickerEls) {
    const on = (btn.dataset.device as DeviceMode) === next;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-checked', String(on));
  }
  fittestUi?.setDeviceMode(next === '8030-usb' ? '8030' : '8020');
  // Sampling Start button: enabled whenever the appropriate
  // device is connected and not currently sampling.
  refreshSamplingButtons();
}

function refreshSamplingButtons(): void {
  if (deviceMode === '8030-usb') {
    startBtn.disabled = !(session !== null && !session.active);
    stopBtn.disabled = !(session?.active);
  } else {
    startBtn.disabled = !(session8020 !== null && !active8020Sampling);
    stopBtn.disabled = !active8020Sampling;
  }
}
for (const btn of devicePickerEls) {
  btn.addEventListener('click', () => {
    if (session || session8020) {
      log('cannot switch device while connected — disconnect first.');
      return;
    }
    setDeviceMode(btn.dataset.device as DeviceMode);
  });
}
setDeviceMode(deviceMode);

// Initialize the fit-test UI. Construct it eagerly so DOM bindings settle
// before the user can possibly click; wire the store in once it opens.
void (async () => {
  const tabRootEl = document.querySelector<HTMLElement>('[data-tab-panel="testruns"]');
  const panelHostEl = document.getElementById('fittest-panel-host');
  if (!tabRootEl || !panelHostEl) return;
  fittestUi = new FitTestUi(tabRootEl, panelHostEl as HTMLElement, {
    log,
    onTestStarted: () => {
      // Disable the realtime sampling buttons while a fit test runs;
      // the device can't serve both flows simultaneously.
      startBtn.disabled = true;
      stopBtn.disabled = true;
    },
    onTestEnded: () => {
      if (session && !session.active && deviceMode === '8030-usb') {
        startBtn.disabled = false;
      }
    },
  });
  // Sync the deviceMode the UI was initialized with (in case the
  // user already clicked a non-default picker option before the UI
  // finished loading).
  fittestUi.setDeviceMode(deviceMode === '8030-usb' ? '8030' : '8020');
  try {
    fittestStore = await openFitTestStore();
    fittestUi.setStore(fittestStore);
    const listEl = document.getElementById('fittest-list');
    if (listEl) {
      const hist = new FitTestHistoryPanel(listEl as HTMLElement, fittestStore);
      await hist.reloadFromStore();
      fittestHistory = hist;
      fittestUi.setHistoryPanel(hist);
    }
  } catch (err) {
    log(`fittest store init failed: ${(err as Error).message}`);
  }
})();

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
}

function ts(): string {
  return new Date().toISOString().substring(11, 23);
}

function log(msg: string): void {
  const line = document.createElement('div');
  line.className = 'log-line';
  line.textContent = `[${ts()}] ${msg}`;
  eventLogEl.appendChild(line);
  eventLogEl.scrollTop = eventLogEl.scrollHeight;
}

/** Append a collapsible XML record to the event log. */
function logXml(direction: 'tx' | 'rx', xml: string): void {
  const details = document.createElement('details');
  details.className = `log-xml ${direction}`;
  const summary = document.createElement('summary');
  const tsSpan = document.createElement('span');
  tsSpan.className = 'ts';
  tsSpan.textContent = `[${ts()}]`;
  const arrow = document.createElement('span');
  arrow.className = `arrow ${direction}`;
  arrow.textContent = direction === 'tx' ? '→' : '←';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = describeXml(xml);
  const size = document.createElement('span');
  size.className = 'size';
  size.textContent = `${xml.length}B`;
  summary.append(tsSpan, arrow, label, size);
  const body = document.createElement('pre');
  body.textContent = xml;
  details.append(summary, body);
  eventLogEl.appendChild(details);
  eventLogEl.scrollTop = eventLogEl.scrollHeight;
}

/**
 * Extract a short label from an XML payload — the path of the first
 * non-MAIN element, optionally with the COMMAND attribute or text value.
 *   `<MAIN><SYSTEM><ALL/></SYSTEM></MAIN>`                       → `SYSTEM/ALL`
 *   `<MAIN><SYSTEM><LOCK COMMAND="WRITE">REMOTE</LOCK></SYSTEM>` → `SYSTEM/LOCK=REMOTE`
 *   `<MAIN><REALTIME>{many leaves}</REALTIME></MAIN>`             → `REALTIME (8 fields)`
 */
function describeXml(xml: string): string {
  const parsed = parseResponse(xml).MAIN;
  if (!parsed) return '(no MAIN)';
  const groupName = Object.keys(parsed)[0];
  if (!groupName) return '(empty MAIN)';
  const group = parsed[groupName as keyof typeof parsed] as Record<string, unknown> | undefined;
  if (!group || typeof group !== 'object') return groupName;
  const leafName = Object.keys(group)[0];
  if (!leafName) return groupName;
  const leafVal = group[leafName];
  const keys = Object.keys(group);
  if (keys.length > 1) return `${groupName} (${keys.length} fields)`;
  if (typeof leafVal === 'string' && leafVal.length > 0 && leafVal.length <= 24) {
    return `${groupName}/${leafName}=${leafVal}`;
  }
  return `${groupName}/${leafName}`;
}

function setStatus(
  elementId: string,
  state: 'ok' | 'error' | 'pending',
  msg: string,
): void {
  const node = el<HTMLElement>(elementId);
  node.className = `status-item ${state}`;
  node.querySelector('.value')!.textContent = msg;
}

function setText(elementId: string, value: string): void {
  el<HTMLElement>(elementId).textContent = value;
}

function ipString(ip: IpOctets): string {
  return ip.join('.');
}

function macString(mac: Uint8Array): string {
  return [...mac].map((b) => b.toString(16).padStart(2, '0')).join(':');
}

function isNonZero(ip: IpOctets): boolean {
  return ip.some((b) => b !== 0);
}

connectBtn.addEventListener('click', () => {
  connectBtn.disabled = true;
  const runner =
    deviceMode === '8030-usb'
      ? connect()
      : connect8020(deviceMode === '8020-sim' ? 'simulator' : 'serial');
  runner.catch((err) => {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
    connectBtn.disabled = false;
    setConnState('disconnected', 'Not connected');
  });
});

disconnectBtn.addEventListener('click', () => {
  disconnectBtn.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = true;
  if (deviceMode === '8030-usb') {
    disconnect().catch((err) => log(`disconnect: ${(err as Error).message}`));
  } else {
    disconnect8020().catch((err) => log(`disconnect (8020): ${(err as Error).message}`));
  }
});

async function connect8020(transport: 'serial' | 'simulator'): Promise<void> {
  if (session8020) throw new Error('8020 already connected');
  setConnState('connecting', `Connecting to 8020 (${transport})…`);

  let stream: ByteStream;
  if (transport === 'simulator') {
    const ws = new WebSocketByteStream({ url: 'ws://localhost:18020', log });
    await ws.ready();
    stream = ws;
  } else {
    const nav = navigator as unknown as {
      serial?: { requestPort: (opts?: { filters?: unknown[] }) => Promise<unknown> };
    };
    if (!nav.serial) {
      throw new Error('Web Serial not available — use Chromium 89+ or Firefox 132+.');
    }
    const port = (await nav.serial.requestPort({
      filters: USB_SERIAL_FILTERS,
    })) as unknown as ConstructorParameters<typeof WebSerialByteStream>[0];
    const wss = new WebSerialByteStream(port, {
      openParams: { baudRate: 1200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' },
      log,
    });
    await wss.ready();
    stream = wss;
  }

  const client = new Portacount8020({ log: (m) => log(`[8020] ${m}`) });
  client.onLine((line) => log(`[8020] < ${line}`));
  log(`connecting via ${stream.info?.label ?? '(unknown)'}…`);
  await client.connect(stream, {
    enableExternalControl: true,
    enableDataTransmission: true,
    requestRuntimeStatus: true,
    requestSettings: true,
  });
  log('8020 connected.');

  session8020 = { client, stream };
  fittestUi?.setPortacount8020(client);
  refreshSamplingButtons();

  setText('sn-val', client.snapshot.settings.serialNumber ?? '—');
  setText('model-val', `PortaCount 8020${client.identity.firmwareVersion ? ` (${client.identity.firmwareVersion})` : ''}`);
  setText('build-val', client.identity.firmwareVersion ?? '—');
  setStatus('usb-status', 'ok', `serial @ ${stream.info?.label ?? '?'}`);
  setStatus('dhcp-status', 'pending', '(n/a for 8020)');
  setStatus('runtime-status', 'ok', client.snapshot.runtime
    ? `battery=${client.snapshot.runtime.battery} pulse=${client.snapshot.runtime.pulse}`
    : 'unknown');
  setStatus('handshake-status', 'ok', 'external control');
  disconnectBtn.disabled = false;
  setConnState('connected', `PortaCount 8020 · SN ${client.snapshot.settings.serialNumber ?? '?'}`);
  connDetails.open = false;
}

async function disconnect8020(): Promise<void> {
  // Tear down sampling first.
  if (active8020Sampling) {
    await stopSampling8020().catch(() => undefined);
  }
  const s = session8020;
  session8020 = null;
  fittestUi?.setPortacount8020(null);
  refreshSamplingButtons();
  if (s) {
    try { await s.client.disconnect(); } catch (err) { log(`[8020] disconnect: ${(err as Error).message}`); }
  }
  for (const id of ['usb-status', 'dhcp-status', 'runtime-status', 'handshake-status']) {
    setStatus(id, 'pending', 'Idle');
  }
  setText('sn-val', '—');
  setText('model-val', '—');
  setText('build-val', '—');
  connectBtn.disabled = false;
  setConnState('disconnected', 'Not connected');
}

startBtn.addEventListener('click', () => {
  if (deviceMode === '8030-usb') {
    if (!session) return;
    startBtn.disabled = true;
    startSampling(session).catch((err) => {
      log(`start: ${(err as Error).message}`);
      startBtn.disabled = false;
    });
  } else {
    if (!session8020) return;
    startBtn.disabled = true;
    startSampling8020(session8020.client).catch((err) => {
      log(`start (8020): ${(err as Error).message}`);
      refreshSamplingButtons();
    });
  }
});

stopBtn.addEventListener('click', () => {
  if (deviceMode === '8030-usb') {
    if (!session) return;
    stopBtn.disabled = true;
    stopSampling(session).catch((err) => log(`stop: ${(err as Error).message}`));
  } else {
    stopBtn.disabled = true;
    stopSampling8020().catch((err) => log(`stop (8020): ${(err as Error).message}`));
  }
});

async function startSampling8020(client: Portacount8020): Promise<void> {
  if (active8020Sampling) return;
  if (!sessionStore || !sessionPanel) {
    log('session store not ready');
    refreshSamplingButtons();
    return;
  }
  const deviceSn = client.snapshot.settings.serialNumber ?? 'unknown';
  const startedAt = await sessionStore.startSession({
    deviceSn,
    deviceModel: '8020',
    deviceBuild: client.identity.firmwareVersion ?? '',
  });
  const card = sessionPanel.beginActive({
    startedAt,
    deviceSn,
    deviceModel: '8020',
    deviceBuild: client.identity.firmwareVersion ?? '',
  });
  // Subscribe to the device's state stream; every state change is
  // potentially a new concentration reading. To rate-limit recording
  // to ~1 Hz (the device's own emission rate), we just key off
  // lastConcentration changing.
  let lastRecorded = -Infinity;
  let lastValueSeen: number | null = null;
  const unsubscribe = client.onState((st) => {
    if (st.lastConcentration === null) return;
    if (st.lastConcentration === lastValueSeen) return;
    lastValueSeen = st.lastConcentration;
    const t = Date.now() - startedAt;
    if (t - lastRecorded < 500) return; // soft 2 Hz cap
    lastRecorded = t;
    const onMask = st.sampleSource === 'mask';
    const sample: SampleRecord = {
      sessionId: startedAt,
      t,
      // 8020 doesn't sample ambient and mask simultaneously. Park
      // the current reading on whichever side the valve points at;
      // the other side is left at 0. The history chart will show
      // staircase-ish data.
      amb: onMask ? 0 : st.lastConcentration,
      mask: onMask ? st.lastConcentration : 0,
      ff: 0, // computed FF only meaningful in a fit test, not raw sampling
      status: `valve=${st.sampleSource}`,
      msg: '',
      lowAlcohol: false,
    };
    // Update sampling-tab readings.
    setText('rt-status', `valve=${st.sampleSource}`);
    if (onMask) setText('rt-mask', st.lastConcentration.toFixed(2));
    else setText('rt-amb', st.lastConcentration.toFixed(2));
    setText('rt-ff', '—');
    setText('rt-msg', '(8020: host-driven; no live FF during sampling)');
    setText('rt-low', '—');
    card.append(sample);
    sessionStore?.recordSample(sample).catch((err) =>
      log(`recordSample: ${(err as Error).message}`),
    );
  });
  active8020Sampling = { sessionId: startedAt, startedAt, card, unsubscribe };
  setSamplingDirty(true);
  log(`[8020] sampling started → session ${startedAt}`);
  refreshSamplingButtons();
}

async function stopSampling8020(): Promise<void> {
  const s = active8020Sampling;
  active8020Sampling = null;
  if (!s) {
    refreshSamplingButtons();
    return;
  }
  s.unsubscribe();
  setSamplingDirty(false);
  const endedAt = Date.now();
  s.card.end(endedAt);
  try {
    await sessionStore?.endSession(s.sessionId, endedAt);
  } catch (err) {
    log(`session end (8020): ${(err as Error).message}`);
  }
  log(`[8020] sampling stopped (session ${s.sessionId})`);
  refreshSamplingButtons();
}

// Best-effort cleanup on page teardown (full reload from Vite HMR, tab
// close, navigation). disconnect() is async — pagehide can't await — but
// the underlying USB control transfers (LOCK=UNLOCK, then RNDIS HALT,
// then releaseInterface, then device.close) are queued in the browser's
// USB process and tend to flush before the page goes away. If they don't,
// we're no worse off than before this handler existed.
window.addEventListener('pagehide', () => {
  if (session) {
    void disconnect();
  }
  if (session8020) {
    void disconnect8020();
  }
});

// USB unplug. Without this, the runner just keeps trying to poll a dead
// transport — pc.command's exchange timeout would eventually fire (3 s),
// but in practice the bulk-IN read can sit indefinitely against an
// unplugged device, so we tear the session down explicitly here.
if (navigator.usb) {
  navigator.usb.addEventListener('disconnect', (e: USBConnectionEvent) => {
    if (session && e.device === session.device) {
      log('USB device unplugged — tearing down session.');
      void disconnect();
    }
  });
}

async function connect(): Promise<void> {
  if (!navigator.usb) {
    throw new Error('WebUSB not available — use a Chromium-based browser over HTTPS or localhost.');
  }

  setConnState('connecting', 'Requesting device…');
  setStatus('usb-status', 'pending', 'Requesting device…');
  const device = await navigator.usb.requestDevice({ filters: [RndisWireLayer.USB_FILTER] });
  log(`device: ${device.manufacturerName} / ${device.productName} serial=${device.serialNumber}`);

  setStatus('usb-status', 'pending', 'Opening RNDIS…');
  const wire = await RndisWireLayer.open(device, { log });
  setStatus('usb-status', 'ok', `RNDIS up — host MAC ${macString(wire.macAddress)}`);

  setStatus('dhcp-status', 'pending', 'Waiting for lease…');
  const stack = await LwipStack.create(
    createLwipModule,
    wire.macAddress,
    (frame) => {
      wire.sendFrame(frame).catch((e) => log(`sendFrame: ${(e as Error).message}`));
    },
    {
      addressing: 'dhcp',
      netmask: [255, 255, 0, 0],
      wasmUrl,
      onIpStatus: (ip, gateway, netmask) => {
        log(`netif: ip=${ip} gw=${gateway} mask=${netmask}`);
      },
    },
  );

  const ourMac = wire.macAddress;
  await wire.startReceiving((frame) => {
    // Drop the RNDIS bulk-IN echo of our own outbound frames.
    if (frame.byteLength >= 12 && frame.subarray(6, 12).every((b, i) => b === ourMac[i])) return;
    stack.injectFrame(frame);
  });

  const deviceIp = await awaitDhcpLease(stack, DHCP_TIMEOUT_MS);
  setStatus(
    'dhcp-status',
    'ok',
    `host ${ipString(stack.ip)} → gateway ${ipString(deviceIp)}`,
  );

  setStatus('runtime-status', 'pending', 'Probing 3602…');
  const pc = new Portacount(stack, log, {
    onTx: (xml) => { if (xmlTraceToggle.checked) logXml('tx', xml); },
    onRx: (xml) => { if (xmlTraceToggle.checked) logXml('rx', xml); },
  });
  let runtime: number | undefined;
  try {
    runtime = await pc.readRuntime(deviceIp, 5000);
    setStatus('runtime-status', 'ok', `${runtime} (RSRTLSVC)`);
  } catch (err) {
    setStatus('runtime-status', 'error', (err as Error).message);
  }

  setStatus('handshake-status', 'pending', 'SYSTEM/ALL…');
  const info = await pc.connect(deviceIp, 1);
  setStatus('handshake-status', 'ok', 'Locked REMOTE');
  setText('sn-val', info.serialNumber);
  setText('model-val', info.modelNumber);
  setText('build-val', info.buildString);

  pc.startKeepAlive();

  session = { wire, stack, pc, device, pollHandle: null, deviceInfo: info, active: null };
  disconnectBtn.disabled = false;
  startBtn.disabled = false;
  setConnState('connected', `SN ${info.serialNumber} · ${info.modelNumber}`);
  // Auto-collapse the details once we're up — the user doesn't need to
  // stare at the stack rundown during normal operation.
  connDetails.open = false;
  fittestUi?.setPortacount(pc, info);

  // One status snapshot immediately so the panel isn't empty.
  await pollRealtimeOnce(session);
}

async function awaitDhcpLease(stack: LwipStack, timeoutMs: number): Promise<IpOctets> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const gw = stack.gateway;
    const ip = stack.ip;
    if (isNonZero(ip) && isNonZero(gw)) return gw;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`DHCP did not complete within ${timeoutMs}ms`);
}

async function startSampling(s: Session): Promise<void> {
  log('REALTIME/START');
  await s.pc.command(Cmd.realtimeStart);
  setSamplingDirty(true);
  stopBtn.disabled = false;

  // Open a recorded session (best-effort — UI works even if IDB fails).
  if (sessionStore && sessionPanel) {
    try {
      const startedAt = await sessionStore.startSession({
        deviceSn: s.deviceInfo.serialNumber,
        deviceModel: s.deviceInfo.modelNumber,
        deviceBuild: s.deviceInfo.buildString,
      });
      const card = sessionPanel.beginActive({
        startedAt,
        deviceSn: s.deviceInfo.serialNumber,
        deviceModel: s.deviceInfo.modelNumber,
        deviceBuild: s.deviceInfo.buildString,
      });
      s.active = { card, sessionId: startedAt, startedAt };
    } catch (err) {
      log(`session start: ${(err as Error).message}`);
    }
  }

  s.pollHandle = setInterval(() => {
    pollRealtimeOnce(s).catch((err) => log(`poll: ${(err as Error).message}`));
  }, POLL_INTERVAL_MS);
}

async function stopSampling(s: Session): Promise<void> {
  if (s.pollHandle !== null) {
    clearInterval(s.pollHandle);
    s.pollHandle = null;
  }
  setSamplingDirty(false);

  // Finalize the recorded session before STOP — order doesn't matter
  // for correctness, but the user-visible card freezing first feels right.
  if (s.active && sessionStore) {
    const endedAt = Date.now();
    s.active.card.end(endedAt);
    try {
      await sessionStore.endSession(s.active.sessionId, endedAt);
    } catch (err) {
      log(`session end: ${(err as Error).message}`);
    }
    s.active = null;
  }

  log('REALTIME/STOP');
  await s.pc.command(Cmd.realtimeStop);
  startBtn.disabled = false;
}

/**
 * Mark the page "dirty" while sampling, so a reload (Vite HMR, ⌘R) or
 * navigation prompts before discarding live data. Browsers ignore any
 * custom message — they just show a generic "Leave site?" dialog as long
 * as the handler exists and sets `returnValue`.
 */
const dirtyHandler = (e: BeforeUnloadEvent): void => {
  e.preventDefault();
  e.returnValue = '';
};
function setSamplingDirty(active: boolean): void {
  if (active) window.addEventListener('beforeunload', dirtyHandler);
  else window.removeEventListener('beforeunload', dirtyHandler);
}

async function pollRealtimeOnce(s: Session): Promise<void> {
  const xml = await s.pc.command(Cmd.realtimeAll);
  const rt = parseResponse(xml).MAIN?.REALTIME;
  if (!rt) return;
  setText('rt-status', rt.STATUS ?? '—');
  setText('rt-amb', rt.AMB_CONC ?? '—');
  setText('rt-mask', rt.MASK_CONC ?? '—');
  setText('rt-ff', rt.FITFACTOR ?? '—');
  setText('rt-msg', rt.MESSAGE && rt.MESSAGE.length ? rt.MESSAGE : '(none)');
  setText('rt-low', rt.LOW_ALCOHOL_WARNING ?? '—');

  // Record into the active session (live card + IDB). Fire-and-forget
  // for IDB — the card holds its own samples array, so the UI never
  // waits on disk.
  if (s.active && sessionStore) {
    const sample: SampleRecord = {
      sessionId: s.active.sessionId,
      t: Date.now() - s.active.startedAt,
      amb: parseFloat(rt.AMB_CONC ?? '0') || 0,
      mask: parseFloat(rt.MASK_CONC ?? '0') || 0,
      ff: parseFloat(rt.FITFACTOR ?? '0') || 0,
      status: rt.STATUS ?? '',
      msg: rt.MESSAGE ?? '',
      lowAlcohol: (rt.LOW_ALCOHOL_WARNING ?? 'false') === 'true',
    };
    s.active.card.append(sample);
    sessionStore.recordSample(sample).catch((err) =>
      log(`recordSample: ${(err as Error).message}`),
    );
  }
}

async function disconnect(): Promise<void> {
  const s = session;
  session = null;
  fittestUi?.setPortacount(null, null);
  if (!s) return;
  if (s.pollHandle !== null) clearInterval(s.pollHandle);
  setSamplingDirty(false);
  // Finalize the active session card (if sampling was on when the user
  // hit Disconnect) so its header switches from "sampling" to "ended".
  if (s.active && sessionStore) {
    const endedAt = Date.now();
    s.active.card.end(endedAt);
    sessionStore.endSession(s.active.sessionId, endedAt).catch((err) =>
      log(`session end on disconnect: ${(err as Error).message}`),
    );
    s.active = null;
  }
  try { await s.pc.disconnect(); } catch (err) { log(`pc.disconnect: ${(err as Error).message}`); }
  try { s.stack.destroy(); } catch (err) { log(`stack.destroy: ${(err as Error).message}`); }
  try { await s.wire.close(); } catch (err) { log(`wire.close: ${(err as Error).message}`); }
  setStatus('usb-status', 'pending', 'Idle');
  setStatus('dhcp-status', 'pending', 'Idle');
  setStatus('runtime-status', 'pending', 'Idle');
  setStatus('handshake-status', 'pending', 'Idle');
  setText('sn-val', '—');
  setText('model-val', '—');
  setText('build-val', '—');
  for (const id of ['rt-status', 'rt-amb', 'rt-mask', 'rt-ff', 'rt-msg', 'rt-low']) setText(id, '—');
  connectBtn.disabled = false;
  setConnState('disconnected', 'Not connected');
  log('disconnected.');
}

// ----- Vite HMR hook -----
// Self-accept main.ts so a file edit propagates as an HMR update rather
// than a full page reload. Vite *awaits* the dispose callback, which
// lets us run the full async disconnect() — including the HALT control
// transfer — before the new bundle takes over. The accept handler then
// forces a fresh `location.reload()` so the new DOM/handlers are bound
// from a clean slate (we can't selectively hot-swap a top-level UI).
if (import.meta.hot) {
  import.meta.hot.dispose(async () => {
    if (session) {
      log('HMR: disposing session before reload…');
      await disconnect();
    }
  });
  import.meta.hot.accept(() => {
    window.location.reload();
  });
}
