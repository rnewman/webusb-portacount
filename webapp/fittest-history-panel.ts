/**
 * History panel for completed fit tests.
 *
 * Cards live in `#fittest-list`, newest first. Each card shows the
 * basic identity (date, person, mask, overall FF + status) and exposes
 * inline editing of the labeling fields — name, mask, notes — so that
 * a run started without identifying info can be labeled later.
 *
 * Exports:
 *   - CSV: per-exercise rows + a samples block (t, amb, mask).
 *   - PNG: rasterized snapshot of the per-test chart (rendered inline
 *     as SVG, the same shape as the sampling card chart).
 */

import type {
  ExerciseResult,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
} from 'webusb-portacount';

import type {
  FitTestRecord,
  FitTestSampleRecord,
  FitTestStore,
} from './fittest-store';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_W = 600;
const CHART_H = 180;
const PAD_L = 50;
const PAD_R = 16;
const PAD_T = 10;
const PAD_B = 24;
const PLOT_W = CHART_W - PAD_L - PAD_R;
const PLOT_H = CHART_H - PAD_T - PAD_B;

const COLOR_AMB = '#00d4ff';
const COLOR_MASK = '#4ade80';
const COLOR_GRID = '#2a2a3e';
const COLOR_AXIS_LABEL = '#888';
const COLOR_CROSSHAIR = '#666';

export interface ActiveFitTestHandle {
  /** Append a sample to the live placeholder card and re-paint its chart. */
  appendSample(s: FitTestSampleRecord): void;
  /** Replace the placeholder with the finalized card. */
  finalize(testId: number): Promise<void>;
}

export class FitTestHistoryPanel {
  private container: HTMLElement;
  private store: FitTestStore;

  constructor(container: HTMLElement, store: FitTestStore) {
    this.container = container;
    this.store = store;
  }

  async reloadFromStore(): Promise<void> {
    this.container.replaceChildren();
    const tests = await this.store.listTests();
    for (const t of tests) {
      const samples = await this.store.getSamples(t.startedAt);
      const card = this.buildCard(t, samples);
      this.container.appendChild(card);
    }
  }

  /** Prepend a placeholder card for an in-flight test. The returned
   *  handle lets the caller stream samples into the card's chart and
   *  finalize the card when the run ends. */
  beginActive(meta: FitTestRecord): ActiveFitTestHandle {
    const liveSamples: FitTestSampleRecord[] = [];
    const placeholder = this.buildCard(meta, liveSamples);
    placeholder.classList.add('active');
    this.container.prepend(placeholder);
    return {
      appendSample: (s) => {
        liveSamples.push(s);
        paintFittestChart(placeholder, liveSamples);
      },
      finalize: async (testId: number) => {
        const tests = await this.store.listTests();
        const t = tests.find((x) => x.startedAt === testId);
        if (!t) {
          placeholder.remove();
          return;
        }
        const samples = await this.store.getSamples(testId);
        const replacement = this.buildCard(t, samples);
        placeholder.replaceWith(replacement);
      },
    };
  }

  private buildCard(t: FitTestRecord, samples: FitTestSampleRecord[]): HTMLElement {
    const card = document.createElement('article');
    card.className = 'fittest-card';
    card.dataset.testId = String(t.startedAt);

    const title = personLabel(t.person) || '(unlabeled)';
    const result = t.result;
    const ff = result?.ffOverall ?? null;
    const status = result?.ffOverallStatus;
    const stats = computeStats(result?.exercises ?? [], samples);

    const header = document.createElement('header');
    header.innerHTML = `
      <div>
        <div class="ftc-title">${escapeHtml(title)}</div>
        <div class="ftc-time">${formatStartTime(t.startedAt)} · ${escapeHtml(protocolName(t.protocol))}</div>
      </div>
      <div class="ftc-overall">
        <span class="ff">${ff !== null ? ff.toFixed(1) : '—'}</span>
        <span class="pill ${pillClass(status, t.aborted)}">${pillLabel(status, t.aborted)}</span>
      </div>
    `;
    card.appendChild(header);

    const statsEl = document.createElement('div');
    statsEl.className = 'ftc-stats';
    statsEl.textContent = stats;
    card.appendChild(statsEl);

    // Inline AMB/MASK chart — same shape as the sampling cards, just
    // without the FF axis (FF lives on per-exercise rows, not samples).
    const chartWrap = document.createElement('div');
    chartWrap.className = 'ftc-svg-wrap';
    const chartSvg = document.createElementNS(SVG_NS, 'svg');
    chartSvg.setAttribute('class', 'ftc-svg');
    chartSvg.setAttribute('viewBox', `0 0 ${CHART_W} ${CHART_H}`);
    chartSvg.setAttribute('preserveAspectRatio', 'none');
    chartWrap.appendChild(chartSvg);
    const tooltip = document.createElement('div');
    tooltip.className = 'ftc-tooltip';
    tooltip.style.display = 'none';
    chartWrap.appendChild(tooltip);
    card.appendChild(chartWrap);
    paintFittestChart(card, samples);

    if (result?.exercises?.length) {
      const exList = document.createElement('div');
      exList.className = 'ftc-exlist';
      for (const r of result.exercises) {
        const row = document.createElement('div');
        row.className = 'fittest-exrow';
        const name = document.createElement('span');
        name.textContent = `${r.index + 1}. ${r.name || '(unnamed)'}`;
        const ffEl = document.createElement('span');
        ffEl.className = 'ff';
        ffEl.textContent = r.fitFactor !== null ? r.fitFactor.toFixed(1) : '—';
        const pill = document.createElement('span');
        pill.className = `pill ${exPillClass(r.status)}`;
        pill.textContent = r.status;
        row.append(name, ffEl, pill);
        exList.appendChild(row);
      }
      card.appendChild(exList);
    }

    const meta = document.createElement('div');
    meta.className = 'ftc-meta';
    meta.innerHTML = `
      <div class="span-2"><label class="label">Name</label><input data-edit="name" type="text" value="${escapeAttr(personLabel(t.person))}" placeholder="John Doe"></div>
      <div class="span-2"><label class="label">Mask</label><input data-edit="maskModel" type="text" value="${escapeAttr(t.mask.model)}" placeholder="3M 8511"></div>
      <div class="span-2"><label class="label">Notes</label><textarea data-edit="note" rows="2" placeholder="optional">${escapeHtml(t.person.note ?? '')}</textarea></div>
    `;
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'ftc-actions';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save label';
    saveBtn.disabled = true;
    const csvBtn = document.createElement('button');
    csvBtn.textContent = 'Export CSV';
    const pngBtn = document.createElement('button');
    pngBtn.textContent = 'Export PNG';
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Delete';
    const savedNote = document.createElement('span');
    savedNote.className = 'ftc-edited';
    savedNote.style.display = 'none';
    savedNote.textContent = 'saved';
    actions.append(saveBtn, csvBtn, pngBtn, delBtn, savedNote);
    card.appendChild(actions);

    // Enable save button on any edit, save persists patch.
    const inputs = meta.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-edit]');
    for (const input of inputs) {
      input.addEventListener('input', () => {
        saveBtn.disabled = false;
        savedNote.style.display = 'none';
      });
    }
    saveBtn.addEventListener('click', () => {
      const patch = collectPatch(meta);
      saveBtn.disabled = true;
      this.store.updateLabels(t.startedAt, patch).then(() => {
        // Update the in-memory record so subsequent re-renders are
        // consistent without a full reload.
        if (patch.person) t.person = { ...t.person, ...patch.person };
        if (patch.mask) t.mask = { ...t.mask, ...patch.mask };
        const newTitle = personLabel(t.person) || '(unlabeled)';
        const titleEl = header.querySelector('.ftc-title');
        if (titleEl) titleEl.textContent = newTitle;
        savedNote.style.display = '';
      }).catch(() => {
        saveBtn.disabled = false;
      });
    });

    csvBtn.addEventListener('click', () => {
      const csv = buildCsv(t, samples);
      downloadBlob(csv, csvFilename(t), 'text/csv;charset=utf-8');
    });

    pngBtn.addEventListener('click', () => {
      void exportChartPng(t, samples, pngFilename(t));
    });

    delBtn.addEventListener('click', () => {
      if (!confirm('Delete this fit test?')) return;
      this.store.deleteTest(t.startedAt).then(() => card.remove()).catch(() => {});
    });

    return card;
  }
}

function collectPatch(meta: HTMLElement): { person: Partial<FitTestPerson>; mask: Partial<FitTestMask> } {
  const get = (k: string) =>
    (meta.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-edit="${k}"]`)?.value ?? '').trim();
  const { firstName, lastName } = splitName(get('name'));
  return {
    person: {
      firstName,
      lastName,
      note: get('note'),
    },
    mask: {
      model: get('maskModel') || 'unknown',
    },
  };
}

/** Mirror of fittest-ui's splitName — keeps history-card edits using the
 *  same single-field convention. */
function splitName(raw: string): { firstName: string; lastName: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { firstName: '', lastName: '' };
  const idx = trimmed.search(/\s+/);
  if (idx < 0) return { firstName: trimmed, lastName: '' };
  return {
    firstName: trimmed.slice(0, idx),
    lastName: trimmed.slice(idx).trim(),
  };
}

/** Returns the runtime `displayName` if the stored object happens to
 *  carry it (records made by this webapp do — see fittest-ui.ts), else
 *  falls back to the device-side `name`. */
function protocolName(p: FitTestProtocolDef): string {
  const withDisplay = p as FitTestProtocolDef & { displayName?: string };
  return withDisplay.displayName || p.name;
}

function personLabel(p: FitTestPerson): string {
  const parts = [p.firstName, p.lastName].filter((s) => s && s.trim().length > 0);
  return parts.join(' ');
}

function pillClass(status: 'PASS' | 'FAIL' | undefined, aborted?: string): string {
  if (aborted) return 'fail';
  if (status === 'PASS') return 'pass';
  if (status === 'FAIL') return 'fail';
  return 'not-started';
}
function pillLabel(status: 'PASS' | 'FAIL' | undefined, aborted?: string): string {
  if (aborted) return 'ABORTED';
  return status ?? '—';
}
function exPillClass(s: string): string {
  switch (s) {
    case 'PASS': return 'pass';
    case 'FAIL': return 'fail';
    case 'TESTING': return 'testing';
    case 'EXCLUDED': return 'excluded';
    default: return 'not-started';
  }
}

function computeStats(exercises: ExerciseResult[], samples: FitTestSampleRecord[]): string {
  const parts: string[] = [];
  const ffs = exercises.map((e) => e.fitFactor).filter((v): v is number => v !== null);
  if (ffs.length) {
    const lo = Math.min(...ffs);
    const hi = Math.max(...ffs);
    parts.push(`FF ${lo.toFixed(1)}–${hi.toFixed(1)}`);
  }
  if (samples.length) {
    const ambs = samples.map((s) => s.amb).filter((v) => Number.isFinite(v) && v > 0);
    const masks = samples.map((s) => s.mask).filter((v) => Number.isFinite(v) && v >= 0);
    if (ambs.length) {
      parts.push(`amb ${Math.min(...ambs).toFixed(0)}–${Math.max(...ambs).toFixed(0)}`);
    }
    if (masks.length) {
      parts.push(`mask ${Math.min(...masks).toFixed(2)}–${Math.max(...masks).toFixed(2)}`);
    }
    parts.push(`${samples.length} samples`);
  }
  return parts.join(' · ') || '—';
}

function buildCsv(t: FitTestRecord, samples: FitTestSampleRecord[]): string {
  const lines: string[] = [];
  lines.push(`# Portacount fit test`);
  lines.push(`# startedAt,${new Date(t.startedAt).toISOString()}`);
  lines.push(`# endedAt,${t.endedAt ? new Date(t.endedAt).toISOString() : ''}`);
  lines.push(`# person,${csvField(personLabel(t.person))}`);
  lines.push(`# idNumber,${csvField(t.person.idNumber)}`);
  if (t.person.note) lines.push(`# notes,${csvField(t.person.note)}`);
  lines.push(`# mask,${csvField(t.mask.model)},${t.start.maskSize}`);
  lines.push(`# passLevel,${t.mask.passLevel}`);
  lines.push(`# device,${csvField(t.deviceSn)},${csvField(t.deviceModel)},${csvField(t.deviceBuild)}`);
  lines.push(`# protocol,${csvField(protocolName(t.protocol))}`);
  const r = t.result;
  if (r) {
    lines.push(`# overallFF,${r.ffOverall ?? ''},${r.ffOverallStatus}`);
  }
  lines.push('');
  lines.push('exerciseIndex,name,fitFactor,status');
  for (const ex of r?.exercises ?? []) {
    lines.push([
      String(ex.index),
      csvField(ex.name),
      ex.fitFactor !== null ? ex.fitFactor.toFixed(2) : '',
      ex.status,
    ].join(','));
  }
  lines.push('');
  lines.push('t_ms,ambient,mask,ambStatus,maskStatus');
  for (const s of samples) {
    lines.push([s.t, s.amb, s.mask, s.ambStatus, s.maskStatus].map(csvField).join(','));
  }
  return lines.join('\n');
}

function csvFilename(t: FitTestRecord): string {
  const who = (personLabel(t.person) || 'unlabeled').replace(/\s+/g, '_');
  const ts = new Date(t.startedAt).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `fittest_${who}_${ts}.csv`;
}
function pngFilename(t: FitTestRecord): string {
  const who = (personLabel(t.person) || 'unlabeled').replace(/\s+/g, '_');
  const ts = new Date(t.startedAt).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  return `fittest_${who}_${ts}.png`;
}

function csvField(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function downloadBlob(content: string | Blob, filename: string, type: string): void {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a tick so the click has been dispatched.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportChartPng(
  t: FitTestRecord,
  samples: FitTestSampleRecord[],
  filename: string,
): Promise<void> {
  const svg = buildChartSvg(t, samples);
  const xml = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('image load failed'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    const W = 800;
    const H = 320;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d unavailable');
    ctx.fillStyle = '#12121e';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);
    canvas.toBlob((blob) => {
      if (blob) downloadBlob(blob, filename, 'image/png');
    }, 'image/png');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Standalone (no DOM hookup) SVG of mask/ambient concentration over time
 *  for one fit test. Mirrors the sampling card's chart shape but is built
 *  as a detached SVG so it can be serialized for PNG export. */
function buildChartSvg(t: FitTestRecord, samples: FitTestSampleRecord[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 800, H = 320;
  const PAD_L = 60, PAD_R = 30, PAD_T = 28, PAD_B = 32;
  const PW = W - PAD_L - PAD_R;
  const PH = H - PAD_T - PAD_B;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('xmlns', NS);
  svg.setAttribute('width', String(W));
  svg.setAttribute('height', String(H));
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(W));
  bg.setAttribute('height', String(H));
  bg.setAttribute('fill', '#12121e');
  svg.appendChild(bg);

  // Title
  const title = document.createElementNS(NS, 'text');
  title.setAttribute('x', String(W / 2));
  title.setAttribute('y', '18');
  title.setAttribute('fill', '#ddd');
  title.setAttribute('font-family', 'system-ui, sans-serif');
  title.setAttribute('font-size', '13');
  title.setAttribute('text-anchor', 'middle');
  const who = personLabel(t.person) || '(unlabeled)';
  title.textContent = `${who} · ${t.mask.model} · ${new Date(t.startedAt).toLocaleString()}`;
  svg.appendChild(title);

  if (samples.length === 0) {
    const note = document.createElementNS(NS, 'text');
    note.setAttribute('x', String(W / 2));
    note.setAttribute('y', String(H / 2));
    note.setAttribute('fill', '#888');
    note.setAttribute('font-family', 'system-ui, sans-serif');
    note.setAttribute('text-anchor', 'middle');
    note.textContent = 'no samples';
    svg.appendChild(note);
    return svg;
  }

  const tMax = Math.max(samples[samples.length - 1].t, 1);
  const concMax = Math.max(1, ...samples.map((s) => Math.max(s.amb, s.mask)));
  const concDom: [number, number] = [1, Math.pow(10, Math.ceil(Math.log10(concMax)))];
  const xOf = (ms: number) => PAD_L + (ms / tMax) * PW;
  const yOf = (v: number) => {
    const c = Math.max(concDom[0], v);
    const l = Math.log10(c);
    const lo = Math.log10(concDom[0]);
    const hi = Math.log10(concDom[1]);
    return PAD_T + (1 - (l - lo) / (hi - lo)) * PH;
  };

  // grid + axis labels
  for (let p = Math.log10(concDom[0]); p <= Math.log10(concDom[1]); p++) {
    const y = yOf(Math.pow(10, p));
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(PAD_L));
    line.setAttribute('y1', String(y));
    line.setAttribute('x2', String(PAD_L + PW));
    line.setAttribute('y2', String(y));
    line.setAttribute('stroke', '#2a2a3e');
    svg.appendChild(line);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', String(PAD_L - 6));
    label.setAttribute('y', String(y));
    label.setAttribute('fill', '#888');
    label.setAttribute('font-family', 'monospace');
    label.setAttribute('font-size', '10');
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    const v = Math.pow(10, p);
    label.textContent = v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v.toFixed(0);
    svg.appendChild(label);
  }

  // polylines
  const ambLine = document.createElementNS(NS, 'polyline');
  ambLine.setAttribute('fill', 'none');
  ambLine.setAttribute('stroke', '#00d4ff');
  ambLine.setAttribute('stroke-width', '1.5');
  ambLine.setAttribute('points', samples.map((s) => `${xOf(s.t)},${yOf(Math.max(1, s.amb))}`).join(' '));
  svg.appendChild(ambLine);
  const maskLine = document.createElementNS(NS, 'polyline');
  maskLine.setAttribute('fill', 'none');
  maskLine.setAttribute('stroke', '#4ade80');
  maskLine.setAttribute('stroke-width', '1.5');
  maskLine.setAttribute('points', samples.map((s) => `${xOf(s.t)},${yOf(Math.max(1, s.mask))}`).join(' '));
  svg.appendChild(maskLine);

  // x ticks
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const ms = (tMax * i) / ticks;
    const x = xOf(ms);
    const label = document.createElementNS(NS, 'text');
    label.setAttribute('x', String(x));
    label.setAttribute('y', String(PAD_T + PH + 14));
    label.setAttribute('fill', '#888');
    label.setAttribute('font-family', 'monospace');
    label.setAttribute('font-size', '10');
    label.setAttribute('text-anchor', 'middle');
    const sec = Math.round(ms / 1000);
    label.textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}:${(sec % 60).toString().padStart(2, '0')}`;
    svg.appendChild(label);
  }

  // legend
  const legend = document.createElementNS(NS, 'g');
  legend.setAttribute('transform', `translate(${PAD_L + 8}, ${PAD_T + 14})`);
  const items: Array<[string, string]> = [['#00d4ff', 'ambient'], ['#4ade80', 'mask']];
  items.forEach(([col, lab], i) => {
    const dot = document.createElementNS(NS, 'rect');
    dot.setAttribute('x', String(i * 80));
    dot.setAttribute('y', '0');
    dot.setAttribute('width', '8');
    dot.setAttribute('height', '8');
    dot.setAttribute('fill', col);
    const txt = document.createElementNS(NS, 'text');
    txt.setAttribute('x', String(i * 80 + 12));
    txt.setAttribute('y', '8');
    txt.setAttribute('fill', '#aaa');
    txt.setAttribute('font-family', 'system-ui, sans-serif');
    txt.setAttribute('font-size', '11');
    txt.textContent = lab;
    legend.append(dot, txt);
  });
  svg.appendChild(legend);

  return svg;
}

function formatStartTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/**
 * (Re)paint the AMB/MASK chart embedded in a fit-test card. Idempotent —
 * called once at card-build time and again on each live sample append.
 */
function paintFittestChart(card: HTMLElement, samples: FitTestSampleRecord[]): void {
  const svg = card.querySelector('svg.ftc-svg') as SVGSVGElement | null;
  const wrap = card.querySelector('.ftc-svg-wrap') as HTMLElement | null;
  const tooltip = card.querySelector('.ftc-tooltip') as HTMLElement | null;
  if (!svg || !wrap || !tooltip) return;

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (samples.length === 0) {
    const txt = chartText(CHART_W / 2, CHART_H / 2, 'no samples yet', COLOR_AXIS_LABEL);
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'middle');
    svg.appendChild(txt);
    detachHover(wrap);
    return;
  }

  const tMaxMs = Math.max(samples[samples.length - 1].t, 1);
  const xOf = (tMs: number) => PAD_L + (tMs / tMaxMs) * PLOT_W;

  const concMax = Math.max(1, ...samples.map((s) => Math.max(s.amb, s.mask)));
  const concDomain: [number, number] = [1, niceCeilingPow10(concMax)];
  const yOf = (v: number) => {
    const clamped = Math.max(concDomain[0], v);
    const logV = Math.log10(clamped);
    const logMin = Math.log10(concDomain[0]);
    const logMax = Math.log10(concDomain[1]);
    return PAD_T + (1 - (logV - logMin) / (logMax - logMin)) * PLOT_H;
  };

  // grid + y-axis labels (log10 conc)
  for (let pow = Math.log10(concDomain[0]); pow <= Math.log10(concDomain[1]); pow++) {
    const y = yOf(Math.pow(10, pow));
    svg.appendChild(chartLine(PAD_L, y, PAD_L + PLOT_W, y, COLOR_GRID, 1));
    const label = chartText(PAD_L - 6, y, formatConc(Math.pow(10, pow)), COLOR_AXIS_LABEL);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    svg.appendChild(label);
  }
  // x-axis time ticks
  const xTicks = niceLinearTicks(0, tMaxMs / 1000, 5);
  for (const sec of xTicks) {
    const x = xOf(sec * 1000);
    const label = chartText(x, PAD_T + PLOT_H + 14, formatSeconds(sec), COLOR_AXIS_LABEL);
    label.setAttribute('text-anchor', 'middle');
    svg.appendChild(label);
  }
  svg.appendChild(chartLine(PAD_L, PAD_T + PLOT_H, PAD_L + PLOT_W, PAD_T + PLOT_H, COLOR_GRID, 1));

  // data
  svg.appendChild(chartPolyline(samples, (s) => [xOf(s.t), yOf(Math.max(1, s.amb))], COLOR_AMB));
  svg.appendChild(chartPolyline(samples, (s) => [xOf(s.t), yOf(Math.max(1, s.mask))], COLOR_MASK));

  // crosshair (populated by hover handler)
  const cross = document.createElementNS(SVG_NS, 'g');
  cross.setAttribute('style', 'display:none');
  cross.appendChild(chartLine(0, PAD_T, 0, PAD_T + PLOT_H, COLOR_CROSSHAIR, 1));
  cross.appendChild(chartDot(0, 0, COLOR_AMB));
  cross.appendChild(chartDot(0, 0, COLOR_MASK));
  svg.appendChild(cross);

  const overlay = document.createElementNS(SVG_NS, 'rect');
  overlay.setAttribute('x', String(PAD_L));
  overlay.setAttribute('y', String(PAD_T));
  overlay.setAttribute('width', String(PLOT_W));
  overlay.setAttribute('height', String(PLOT_H));
  overlay.setAttribute('fill', 'transparent');
  overlay.setAttribute('pointer-events', 'all');
  svg.appendChild(overlay);

  attachHover(wrap, svg, tooltip, cross, samples, xOf, yOf);
}

function chartPolyline(
  samples: FitTestSampleRecord[],
  project: (s: FitTestSampleRecord) => [number, number],
  stroke: string,
): SVGPolylineElement {
  const el = document.createElementNS(SVG_NS, 'polyline');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', '1.5');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('points', samples.map((s) => project(s).join(',')).join(' '));
  return el;
}

function chartLine(x1: number, y1: number, x2: number, y2: number, stroke: string, w: number): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', String(x1));
  el.setAttribute('y1', String(y1));
  el.setAttribute('x2', String(x2));
  el.setAttribute('y2', String(y2));
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', String(w));
  return el;
}

function chartDot(cx: number, cy: number, fill: string): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', String(cx));
  el.setAttribute('cy', String(cy));
  el.setAttribute('r', '3');
  el.setAttribute('fill', fill);
  return el;
}

function chartText(x: number, y: number, s: string, fill: string): SVGTextElement {
  const el = document.createElementNS(SVG_NS, 'text');
  el.setAttribute('x', String(x));
  el.setAttribute('y', String(y));
  el.setAttribute('fill', fill);
  el.setAttribute('font-size', '10');
  el.setAttribute('font-family', 'SF Mono, Fira Code, monospace');
  el.textContent = s;
  return el;
}

function detachHover(wrap: HTMLElement): void {
  const handle = wrap as unknown as { __ftcHoverHandler?: EventListener };
  if (handle.__ftcHoverHandler) {
    wrap.removeEventListener('pointermove', handle.__ftcHoverHandler);
    wrap.removeEventListener('pointerleave', handle.__ftcHoverHandler);
  }
}

function attachHover(
  wrap: HTMLElement,
  svg: SVGSVGElement,
  tooltip: HTMLElement,
  cross: Element,
  samples: FitTestSampleRecord[],
  xOf: (tMs: number) => number,
  yOf: (v: number) => number,
): void {
  detachHover(wrap);

  const dots = Array.from(cross.querySelectorAll('circle')) as SVGCircleElement[];
  const vline = cross.querySelector('line') as SVGLineElement;

  const handler = (e: Event) => {
    if (e.type === 'pointerleave') {
      tooltip.style.display = 'none';
      cross.setAttribute('style', 'display:none');
      return;
    }
    const ev = e as PointerEvent;
    const rect = svg.getBoundingClientRect();
    const svgX = ((ev.clientX - rect.left) / rect.width) * CHART_W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const dx = Math.abs(xOf(samples[i].t) - svgX);
      if (dx < bestDist) { bestDist = dx; best = i; }
    }
    const s = samples[best];
    const sx = xOf(s.t);
    vline.setAttribute('x1', String(sx));
    vline.setAttribute('x2', String(sx));
    dots[0].setAttribute('cx', String(sx));
    dots[0].setAttribute('cy', String(yOf(Math.max(1, s.amb))));
    dots[1].setAttribute('cx', String(sx));
    dots[1].setAttribute('cy', String(yOf(Math.max(1, s.mask))));
    cross.setAttribute('style', 'display:inline');

    tooltip.innerHTML =
      `<div><span class="tt-t">t=${(s.t / 1000).toFixed(1)}s</span></div>` +
      `<div><span class="tt-amb">amb</span> ${formatConcExact(s.amb)}</div>` +
      `<div><span class="tt-mask">mask</span> ${formatConcExact(s.mask)}</div>`;
    tooltip.style.display = 'block';
    const px = ev.clientX - rect.left;
    const py = ev.clientY - rect.top;
    const ttW = tooltip.offsetWidth;
    const ttH = tooltip.offsetHeight;
    const wrapW = wrap.clientWidth;
    const wrapH = wrap.clientHeight;
    const tx = px + 12 + ttW > wrapW ? px - ttW - 12 : px + 12;
    const ty = py + 12 + ttH > wrapH ? py - ttH - 12 : py + 12;
    tooltip.style.left = `${Math.max(0, tx)}px`;
    tooltip.style.top = `${Math.max(0, ty)}px`;
  };

  (wrap as unknown as { __ftcHoverHandler?: EventListener }).__ftcHoverHandler = handler;
  wrap.addEventListener('pointermove', handler);
  wrap.addEventListener('pointerleave', handler);
}

function niceCeilingPow10(v: number): number {
  if (v <= 1) return 10;
  return Math.pow(10, Math.ceil(Math.log10(v)));
}

function niceLinearTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

function formatConc(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(0)}k`;
  return v.toFixed(0);
}

function formatConcExact(v: number): string {
  if (v >= 1000) return v.toFixed(0);
  if (v >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
