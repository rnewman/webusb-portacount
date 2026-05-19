/**
 * Live progress UI for an in-flight fit test.
 *
 * The panel is rendered stateless from the latest {@link FitTestStatus}
 * the runner emits. It owns no derived state — every `update()` paints
 * the full view from scratch.
 */

import type {
  ExerciseSnapshot,
  ExerciseStatus,
  FitTestStatus,
} from 'webusb-portacount';

interface PanelElements {
  root: HTMLElement;
  phase: HTMLElement;
  progressBar: HTMLElement;
  progressText: HTMLElement;
  timeText: HTMLElement;
  exerciseNumber: HTMLElement;
  ambVal: HTMLElement;
  ambPill: HTMLElement;
  maskVal: HTMLElement;
  maskPill: HTMLElement;
  overall: HTMLElement;
  overallPill: HTMLElement;
  errorBanner: HTMLElement;
  warningBanner: HTMLElement;
  exerciseList: HTMLElement;
}

export class FitTestPanel {
  private els: PanelElements;

  constructor(container: HTMLElement) {
    container.replaceChildren();
    this.els = buildPanel(container);
    this.reset();
  }

  /** Hide the panel (no active test). */
  hide(): void {
    this.els.root.style.display = 'none';
  }
  show(): void {
    this.els.root.style.display = '';
  }

  /** Reset to the pre-start state. */
  reset(): void {
    this.els.phase.textContent = 'Idle';
    this.els.progressBar.style.width = '0%';
    this.els.progressText.textContent = '0%';
    this.els.timeText.textContent = '0 / 0 s';
    this.els.exerciseNumber.textContent = '—';
    this.els.ambVal.textContent = '—';
    this.els.ambPill.textContent = '';
    this.els.ambPill.className = 'pill';
    this.els.maskVal.textContent = '—';
    this.els.maskPill.textContent = '';
    this.els.maskPill.className = 'pill';
    this.els.overall.textContent = '—';
    this.els.overallPill.textContent = '';
    this.els.overallPill.className = 'pill';
    this.els.errorBanner.style.display = 'none';
    this.els.warningBanner.style.display = 'none';
    this.els.exerciseList.replaceChildren();
  }

  /** Render the given snapshot. */
  update(status: FitTestStatus, ctx?: { protocolName?: string }): void {
    this.show();
    this.els.phase.textContent = status.status || 'starting…';
    const pct = Math.max(0, Math.min(100, status.progressPercent));
    this.els.progressBar.style.width = `${pct}%`;
    this.els.progressText.textContent = `${pct}%`;
    this.els.timeText.textContent = `${status.seconds} / ${status.totalSeconds} s`;
    this.els.exerciseNumber.textContent =
      status.status === 'IDLE' ? '—' : String(status.exerciseNumber + 1);
    this.els.ambVal.textContent = formatConc(status.ambConc);
    setPillForStatus(this.els.ambPill, status.ambConcStatus);
    this.els.maskVal.textContent = formatConc(status.maskConc);
    setPillForStatus(this.els.maskPill, status.maskConcStatus);
    if (status.ffOverall !== null) {
      this.els.overall.textContent = status.ffOverall.toFixed(1);
      setPillForStatus(this.els.overallPill, status.ffOverallStatus);
    } else {
      this.els.overall.textContent = '—';
      setPillForStatus(this.els.overallPill, undefined);
    }
    if (status.error) {
      this.els.errorBanner.textContent = `Device error: ${status.error}`;
      this.els.errorBanner.style.display = '';
    } else {
      this.els.errorBanner.style.display = 'none';
    }
    const warnings: string[] = [];
    if (status.lowAlcoholWarning) warnings.push('Low alcohol — refill cartridge soon');
    if (status.lowParticleWarning) warnings.push('Low ambient particle count');
    if (warnings.length > 0) {
      this.els.warningBanner.textContent = warnings.join(' · ');
      this.els.warningBanner.style.display = '';
    } else {
      this.els.warningBanner.style.display = 'none';
    }

    if (ctx?.protocolName) {
      // (rendered in header — see buildPanel)
    }

    this.paintExerciseList(status.exercises);
  }

  private paintExerciseList(exercises: ExerciseSnapshot[]): void {
    // Filter out trailing NOT_STARTED slots so a 4-exercise protocol
    // doesn't show 8 empty rows. Keep all rows up to the last that has
    // any data (name set or status not NOT_STARTED).
    let lastUseful = -1;
    for (let i = 0; i < exercises.length; i++) {
      if (exercises[i].name !== '' || exercises[i].status !== 'NOT_STARTED') {
        lastUseful = i;
      }
    }
    const items = exercises.slice(0, lastUseful + 1);
    if (items.length === 0) {
      this.els.exerciseList.replaceChildren();
      return;
    }
    const rows: HTMLElement[] = items.map((e) => {
      const row = document.createElement('div');
      row.className = 'fittest-exrow';
      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = `${e.index + 1}. ${e.name || '(unnamed)'}`;
      const ffEl = document.createElement('span');
      ffEl.className = 'ff';
      ffEl.textContent = e.fitFactor !== null ? e.fitFactor.toFixed(1) : '—';
      const pillEl = document.createElement('span');
      pillEl.className = 'pill';
      setPillForExercise(pillEl, e.status);
      row.append(nameEl, ffEl, pillEl);
      return row;
    });
    this.els.exerciseList.replaceChildren(...rows);
  }
}

function buildPanel(container: HTMLElement): PanelElements {
  const root = document.createElement('div');
  root.id = 'fittest-panel';
  root.className = 'fittest-panel';

  const header = document.createElement('div');
  header.className = 'fittest-header';
  const phase = document.createElement('div');
  phase.className = 'fittest-phase';
  const overallWrap = document.createElement('div');
  overallWrap.className = 'fittest-overall';
  const overallLabel = document.createElement('span');
  overallLabel.className = 'label';
  overallLabel.textContent = 'Overall FF';
  const overall = document.createElement('span');
  overall.className = 'value';
  overall.textContent = '—';
  const overallPill = document.createElement('span');
  overallPill.className = 'pill';
  overallWrap.append(overallLabel, overall, overallPill);
  header.append(phase, overallWrap);

  const progress = document.createElement('div');
  progress.className = 'fittest-progress';
  const bar = document.createElement('div');
  bar.className = 'fittest-bar';
  const barFill = document.createElement('div');
  barFill.className = 'fittest-bar-fill';
  bar.appendChild(barFill);
  const progressText = document.createElement('span');
  progressText.className = 'fittest-progress-pct';
  progressText.textContent = '0%';
  const timeText = document.createElement('span');
  timeText.className = 'fittest-time';
  timeText.textContent = '0 / 0 s';
  progress.append(bar, progressText, timeText);

  const concWrap = document.createElement('div');
  concWrap.className = 'fittest-conc';
  const ambBox = document.createElement('div');
  ambBox.className = 'fittest-concbox';
  ambBox.innerHTML = '<span class="label">Ambient</span>';
  const ambVal = document.createElement('span');
  ambVal.className = 'value';
  ambVal.textContent = '—';
  const ambPill = document.createElement('span');
  ambPill.className = 'pill';
  ambBox.append(ambVal, ambPill);
  const maskBox = document.createElement('div');
  maskBox.className = 'fittest-concbox';
  maskBox.innerHTML = '<span class="label">Mask</span>';
  const maskVal = document.createElement('span');
  maskVal.className = 'value';
  maskVal.textContent = '—';
  const maskPill = document.createElement('span');
  maskPill.className = 'pill';
  maskBox.append(maskVal, maskPill);
  const exNumBox = document.createElement('div');
  exNumBox.className = 'fittest-concbox';
  exNumBox.innerHTML = '<span class="label">Exercise</span>';
  const exerciseNumber = document.createElement('span');
  exerciseNumber.className = 'value';
  exerciseNumber.textContent = '—';
  exNumBox.append(exerciseNumber);
  concWrap.append(ambBox, maskBox, exNumBox);

  const errorBanner = document.createElement('div');
  errorBanner.className = 'fittest-banner error';
  errorBanner.style.display = 'none';
  const warningBanner = document.createElement('div');
  warningBanner.className = 'fittest-banner warning';
  warningBanner.style.display = 'none';

  const exerciseListLabel = document.createElement('div');
  exerciseListLabel.className = 'fittest-section-label';
  exerciseListLabel.textContent = 'Exercises';
  const exerciseList = document.createElement('div');
  exerciseList.className = 'fittest-exlist';

  root.append(header, progress, concWrap, errorBanner, warningBanner, exerciseListLabel, exerciseList);
  container.appendChild(root);

  return {
    root, phase, progressBar: barFill, progressText, timeText, exerciseNumber,
    ambVal, ambPill, maskVal, maskPill, overall, overallPill,
    errorBanner, warningBanner, exerciseList,
  };
}

function setPillForStatus(el: HTMLElement, status: 'PASS' | 'FAIL' | 'TESTING' | undefined): void {
  el.className = 'pill';
  if (status === 'PASS') { el.classList.add('pass'); el.textContent = 'PASS'; }
  else if (status === 'FAIL') { el.classList.add('fail'); el.textContent = 'FAIL'; }
  else if (status === 'TESTING') { el.classList.add('testing'); el.textContent = 'TESTING'; }
  else { el.textContent = ''; }
}

function setPillForExercise(el: HTMLElement, status: ExerciseStatus): void {
  el.className = 'pill';
  switch (status) {
    case 'PASS': el.classList.add('pass'); el.textContent = 'PASS'; break;
    case 'FAIL': el.classList.add('fail'); el.textContent = 'FAIL'; break;
    case 'TESTING': el.classList.add('testing'); el.textContent = 'TESTING'; break;
    case 'EXCLUDED': el.classList.add('excluded'); el.textContent = 'EXCLUDED'; break;
    default: el.classList.add('not-started'); el.textContent = '—'; break;
  }
}

function formatConc(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}
