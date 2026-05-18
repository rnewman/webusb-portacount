import { LwipStack, type IpOctets } from '@/lwip-wasm';
import { RndisWireLayer } from '@/rndis';
import { Cmd, type DeviceInfo, Portacount, parseResponse } from '@/portacount';
import { openSessionStore, type SampleRecord, type SessionStore } from './session-store';
import { SessionPanel, type ActiveCardHandle } from './session-panel';

const DHCP_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1000;

const eventLogEl = el<HTMLDivElement>('event-log');
const connectBtn = el<HTMLButtonElement>('connect-btn');
const disconnectBtn = el<HTMLButtonElement>('disconnect-btn');
const startBtn = el<HTMLButtonElement>('start-btn');
const stopBtn = el<HTMLButtonElement>('stop-btn');
const xmlTraceToggle = el<HTMLInputElement>('xml-trace-toggle');
const sessionListEl = el<HTMLDivElement>('session-list');

interface Session {
  wire: RndisWireLayer;
  stack: LwipStack;
  pc: Portacount;
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
  connect().catch((err) => {
    log(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
    console.error(err);
    connectBtn.disabled = false;
  });
});

disconnectBtn.addEventListener('click', () => {
  disconnectBtn.disabled = true;
  startBtn.disabled = true;
  stopBtn.disabled = true;
  disconnect().catch((err) => log(`disconnect: ${(err as Error).message}`));
});

startBtn.addEventListener('click', () => {
  if (!session) return;
  startBtn.disabled = true;
  startSampling(session).catch((err) => {
    log(`start: ${(err as Error).message}`);
    startBtn.disabled = false;
  });
});

stopBtn.addEventListener('click', () => {
  if (!session) return;
  stopBtn.disabled = true;
  stopSampling(session).catch((err) => log(`stop: ${(err as Error).message}`));
});

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
});

async function connect(): Promise<void> {
  if (!navigator.usb) {
    throw new Error('WebUSB not available — use a Chromium-based browser over HTTPS or localhost.');
  }

  setStatus('usb-status', 'pending', 'Requesting device…');
  const device = await navigator.usb.requestDevice({ filters: [RndisWireLayer.USB_FILTER] });
  log(`device: ${device.manufacturerName} / ${device.productName} serial=${device.serialNumber}`);

  setStatus('usb-status', 'pending', 'Opening RNDIS…');
  const wire = await RndisWireLayer.open(device, { log });
  setStatus('usb-status', 'ok', `RNDIS up — host MAC ${macString(wire.macAddress)}`);

  setStatus('dhcp-status', 'pending', 'Waiting for lease…');
  const stack = await LwipStack.create(
    '/wasm/lwip.js',
    wire.macAddress,
    (frame) => {
      wire.sendFrame(frame).catch((e) => log(`sendFrame: ${(e as Error).message}`));
    },
    {
      addressing: 'dhcp',
      netmask: [255, 255, 0, 0],
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

  session = { wire, stack, pc, pollHandle: null, deviceInfo: info, active: null };
  disconnectBtn.disabled = false;
  startBtn.disabled = false;

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
