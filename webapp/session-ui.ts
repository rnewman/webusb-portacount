/**
 * Session card + SVG chart rendering.
 *
 * One card per session. Chart has two y-axes:
 *   left (log10):  AMB_CONC + MASK_CONC in particles/cm³
 *   right (linear): FITFACTOR (typically 1–200+)
 *
 * Hover anywhere on the plot area shows a crosshair and a tooltip
 * with the time-since-start and the three values at the nearest sample.
 *
 * Pure rendering: buildCard creates the skeleton once; paintChart
 * (re)renders the SVG body. For live sessions main.ts calls paintChart
 * each second; the card element is reused so scroll position and any
 * event-listener state survive.
 */

import type { SampleRecord, SessionRecord } from './session-store';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VB_W = 600;
const VB_H = 200;
const PAD_L = 50;
const PAD_R = 40;
const PAD_T = 12;
const PAD_B = 26;
const PLOT_W = VB_W - PAD_L - PAD_R;
const PLOT_H = VB_H - PAD_T - PAD_B;

const COLOR_AMB = '#00d4ff';
const COLOR_MASK = '#4ade80';
const COLOR_FF = '#f59e0b';
const COLOR_GRID = '#2a2a3e';
const COLOR_AXIS_LABEL = '#888';
const COLOR_CROSSHAIR = '#666';

/** Create the static card skeleton; chart starts empty. */
export function buildCard(meta: SessionRecord): HTMLElement {
  const card = document.createElement('article');
  card.className = 'session-card';
  card.dataset.sessionId = String(meta.startedAt);

  const header = document.createElement('header');
  header.className = 'session-header';
  header.innerHTML = `
    <div class="session-meta">
      <div class="session-time">${formatStartTime(meta.startedAt)}</div>
      <div class="session-stats" data-stats>—</div>
    </div>
    <div class="session-device">SN ${escapeHtml(meta.deviceSn)} · model ${escapeHtml(meta.deviceModel)} · build ${escapeHtml(meta.deviceBuild)}</div>
  `;
  card.appendChild(header);

  const wrap = document.createElement('div');
  wrap.className = 'session-svg-wrap';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'session-svg');
  svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  wrap.appendChild(svg);

  const tooltip = document.createElement('div');
  tooltip.className = 'session-tooltip';
  tooltip.style.display = 'none';
  wrap.appendChild(tooltip);

  card.appendChild(wrap);
  return card;
}

/** Convenience: build + paint in one call. */
export function renderSessionCard(
  meta: SessionRecord,
  samples: SampleRecord[],
): HTMLElement {
  const card = buildCard(meta);
  paintChart(card, samples, meta.endedAt);
  return card;
}

/**
 * Repaint the chart in `card` with the given samples. Safe to call
 * many times — wipes the SVG body and rebuilds, but the card element
 * and its event listeners survive.
 */
export function paintChart(
  card: HTMLElement,
  samples: SampleRecord[],
  endedAt: number | undefined,
): void {
  const svg = card.querySelector('svg.session-svg') as SVGSVGElement | null;
  const statsEl = card.querySelector('[data-stats]') as HTMLElement | null;
  const wrap = card.querySelector('.session-svg-wrap') as HTMLElement | null;
  const tooltip = card.querySelector('.session-tooltip') as HTMLElement | null;
  if (!svg || !statsEl || !wrap || !tooltip) return;

  statsEl.textContent = formatStats(samples, endedAt);

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  if (samples.length === 0) {
    const t = svgText(VB_W / 2, VB_H / 2, 'no data', COLOR_AXIS_LABEL);
    t.setAttribute('text-anchor', 'middle');
    t.setAttribute('dominant-baseline', 'middle');
    svg.appendChild(t);
    detachHover(wrap);
    return;
  }

  // ---- scales ----
  const tMaxMs = Math.max(samples[samples.length - 1].t, 1);
  const xOf = (tMs: number) => PAD_L + (tMs / tMaxMs) * PLOT_W;

  const concMax = Math.max(
    1,
    ...samples.map((s) => Math.max(s.amb, s.mask)),
  );
  const concDomain: [number, number] = [1, niceCeilingPow10(concMax)];
  const yLeftOf = (v: number) => {
    const clamped = Math.max(concDomain[0], v);
    const logV = Math.log10(clamped);
    const logMin = Math.log10(concDomain[0]);
    const logMax = Math.log10(concDomain[1]);
    return PAD_T + (1 - (logV - logMin) / (logMax - logMin)) * PLOT_H;
  };

  const ffMax = Math.max(10, ...samples.map((s) => s.ff));
  const ffDomain: [number, number] = [0, niceCeilingLinear(ffMax)];
  const yRightOf = (v: number) =>
    PAD_T + (1 - (v - ffDomain[0]) / (ffDomain[1] - ffDomain[0])) * PLOT_H;

  // ---- grid ----
  for (let pow = Math.log10(concDomain[0]); pow <= Math.log10(concDomain[1]); pow++) {
    const y = yLeftOf(Math.pow(10, pow));
    svg.appendChild(svgLine(PAD_L, y, PAD_L + PLOT_W, y, COLOR_GRID, 1));
  }

  // ---- axes ----
  // Left y-axis (log conc)
  for (let pow = Math.log10(concDomain[0]); pow <= Math.log10(concDomain[1]); pow++) {
    const y = yLeftOf(Math.pow(10, pow));
    const label = svgText(PAD_L - 6, y, formatConc(Math.pow(10, pow)), COLOR_AXIS_LABEL);
    label.setAttribute('text-anchor', 'end');
    label.setAttribute('dominant-baseline', 'middle');
    svg.appendChild(label);
  }
  // Right y-axis (linear FF)
  const ffTicks = niceLinearTicks(ffDomain[0], ffDomain[1], 5);
  for (const v of ffTicks) {
    const y = yRightOf(v);
    const label = svgText(PAD_L + PLOT_W + 6, y, formatFf(v), COLOR_FF);
    label.setAttribute('text-anchor', 'start');
    label.setAttribute('dominant-baseline', 'middle');
    svg.appendChild(label);
  }
  // X axis (time)
  const xTicks = niceLinearTicks(0, tMaxMs / 1000, 5);
  for (const sec of xTicks) {
    const x = xOf(sec * 1000);
    const label = svgText(x, PAD_T + PLOT_H + 14, formatSeconds(sec), COLOR_AXIS_LABEL);
    label.setAttribute('text-anchor', 'middle');
    svg.appendChild(label);
  }
  // axis line at bottom of plot
  svg.appendChild(svgLine(PAD_L, PAD_T + PLOT_H, PAD_L + PLOT_W, PAD_T + PLOT_H, COLOR_GRID, 1));

  // ---- data lines ----
  svg.appendChild(polyline(samples, (s) => [xOf(s.t), yLeftOf(s.amb)], COLOR_AMB));
  svg.appendChild(polyline(samples, (s) => [xOf(s.t), yLeftOf(s.mask)], COLOR_MASK));
  svg.appendChild(polyline(samples, (s) => [xOf(s.t), yRightOf(s.ff)], COLOR_FF));

  // ---- crosshair group (populated by hover handler) ----
  const cross = document.createElementNS(SVG_NS, 'g');
  cross.setAttribute('class', 'crosshair');
  cross.setAttribute('style', 'display:none');
  cross.appendChild(svgLine(0, PAD_T, 0, PAD_T + PLOT_H, COLOR_CROSSHAIR, 1));
  cross.appendChild(svgDot(0, 0, COLOR_AMB));
  cross.appendChild(svgDot(0, 0, COLOR_MASK));
  cross.appendChild(svgDot(0, 0, COLOR_FF));
  svg.appendChild(cross);

  // ---- transparent overlay capturing pointer ----
  const overlay = document.createElementNS(SVG_NS, 'rect');
  overlay.setAttribute('x', String(PAD_L));
  overlay.setAttribute('y', String(PAD_T));
  overlay.setAttribute('width', String(PLOT_W));
  overlay.setAttribute('height', String(PLOT_H));
  overlay.setAttribute('fill', 'transparent');
  overlay.setAttribute('pointer-events', 'all');
  svg.appendChild(overlay);

  attachHover(wrap, svg, tooltip, cross, samples, xOf, yLeftOf, yRightOf);
}

function polyline(
  samples: SampleRecord[],
  project: (s: SampleRecord) => [number, number],
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

function svgLine(x1: number, y1: number, x2: number, y2: number, stroke: string, w: number): SVGLineElement {
  const el = document.createElementNS(SVG_NS, 'line');
  el.setAttribute('x1', String(x1));
  el.setAttribute('y1', String(y1));
  el.setAttribute('x2', String(x2));
  el.setAttribute('y2', String(y2));
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', String(w));
  return el;
}

function svgDot(cx: number, cy: number, fill: string): SVGCircleElement {
  const el = document.createElementNS(SVG_NS, 'circle');
  el.setAttribute('cx', String(cx));
  el.setAttribute('cy', String(cy));
  el.setAttribute('r', '3');
  el.setAttribute('fill', fill);
  return el;
}

function svgText(x: number, y: number, s: string, fill: string): SVGTextElement {
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
  const existing = (wrap as unknown as { __hoverHandler?: EventListener }).__hoverHandler;
  if (existing) {
    wrap.removeEventListener('pointermove', existing);
    wrap.removeEventListener('pointerleave', existing);
  }
}

function attachHover(
  wrap: HTMLElement,
  svg: SVGSVGElement,
  tooltip: HTMLElement,
  cross: Element,
  samples: SampleRecord[],
  xOf: (tMs: number) => number,
  yLeftOf: (v: number) => number,
  yRightOf: (v: number) => number,
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
    const svgX = ((ev.clientX - rect.left) / rect.width) * VB_W;
    // find nearest sample by x in SVG coords
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
    dots[0].setAttribute('cy', String(yLeftOf(s.amb)));
    dots[1].setAttribute('cx', String(sx));
    dots[1].setAttribute('cy', String(yLeftOf(s.mask)));
    dots[2].setAttribute('cx', String(sx));
    dots[2].setAttribute('cy', String(yRightOf(s.ff)));
    cross.setAttribute('style', 'display:inline');

    tooltip.innerHTML =
      `<div><span class="tt-t">t=${(s.t / 1000).toFixed(1)}s</span></div>` +
      `<div><span class="tt-amb">amb</span> ${formatConcExact(s.amb)}</div>` +
      `<div><span class="tt-mask">mask</span> ${formatConcExact(s.mask)}</div>` +
      `<div><span class="tt-ff">FF</span> ${formatFfExact(s.ff)}</div>`;
    tooltip.style.display = 'block';
    // Place below-right of cursor by default; flip if either edge would
    // overflow the wrap (which would otherwise trigger scrollbars on the
    // ancestor #session-list).
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

  (wrap as unknown as { __hoverHandler?: EventListener }).__hoverHandler = handler;
  wrap.addEventListener('pointermove', handler);
  wrap.addEventListener('pointerleave', handler);
}

// ---- formatters ----

function formatStartTime(epochMs: number): string {
  const d = new Date(epochMs);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function formatStats(samples: SampleRecord[], endedAt: number | undefined): string {
  if (samples.length === 0) return endedAt ? 'ended · 0 samples' : 'starting…';
  const last = samples[samples.length - 1];
  const durMs = endedAt ? endedAt - (endedAt - last.t) : last.t;
  const peakFf = samples.reduce((m, s) => Math.max(m, s.ff), 0);
  const tag = endedAt ? 'ended' : 'sampling';
  return `${tag} · ${formatDuration(durMs)} · ${samples.length} samples · peak FF ${peakFf.toFixed(0)}`;
}

function formatDuration(ms: number): string {
  const totalS = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalS / 60);
  const s = totalS % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatSeconds(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
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

function formatFf(v: number): string {
  return v.toFixed(0);
}

function formatFfExact(v: number): string {
  return v.toFixed(1);
}

function niceCeilingPow10(v: number): number {
  if (v <= 1) return 10;
  return Math.pow(10, Math.ceil(Math.log10(v)));
}

function niceCeilingLinear(v: number): number {
  if (v <= 0) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const mantissa = v / exp;
  let nice: number;
  if (mantissa <= 1) nice = 1;
  else if (mantissa <= 2) nice = 2;
  else if (mantissa <= 5) nice = 5;
  else nice = 10;
  return nice * exp;
}

function niceLinearTicks(min: number, max: number, count: number): number[] {
  const step = (max - min) / count;
  const out: number[] = [];
  for (let i = 0; i <= count; i++) out.push(min + step * i);
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
