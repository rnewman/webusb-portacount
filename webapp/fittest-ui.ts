/**
 * Glue between the fit-test form, the FitTestRunner, the progress panel,
 * and the IDB store. Keeps `main.ts` from drowning in fit-test wiring.
 */

import {
  FitTestRunner,
  type DeviceInfo,
  type FitTestMask,
  type FitTestPerson,
  type FitTestProtocolDef,
  type FitTestStartOptions,
  type Portacount,
} from 'webusb-portacount';

import { DEFAULT_PROTOCOLS, type NamedProtocol } from './fittest-defaults';
import { FitTestPanel } from './fittest-panel';
import type { FitTestStore } from './fittest-store';
import type { ActiveFitTestHandle, FitTestHistoryPanel } from './fittest-history-panel';

export interface FitTestUiCallbacks {
  log: (msg: string) => void;
  /** Called whenever a run starts; the host should disable
   * sampling-related UI until `onTestEnded`. */
  onTestStarted: () => void;
  onTestEnded: () => void;
}

interface ActiveRun {
  testId: number;
  runner: FitTestRunner;
  historyHandle: ActiveFitTestHandle | null;
}

export class FitTestUi {
  private panel: FitTestPanel;
  private store: FitTestStore | null = null;
  private history: FitTestHistoryPanel | null = null;
  private pc: Portacount | null = null;
  private deviceInfo: DeviceInfo | null = null;
  private active: ActiveRun | null = null;
  private cb: FitTestUiCallbacks;
  private tabRoot: HTMLElement;
  private startBtn: HTMLButtonElement;
  private abortBtn: HTMLButtonElement;
  private protocolSelect: HTMLSelectElement;
  private protocolSummary: HTMLElement | null;
  private personName: HTMLInputElement;
  private personId: HTMLInputElement;
  private maskModel: HTMLInputElement;
  private maskSize: HTMLInputElement;
  private maskPassLevel: HTMLInputElement;
  private maskN95: HTMLInputElement;
  private operator: HTMLInputElement;
  private notes: HTMLTextAreaElement;
  private endOnUnachievable: HTMLInputElement;

  constructor(tabRoot: HTMLElement, panelRoot: HTMLElement, cb: FitTestUiCallbacks) {
    this.cb = cb;
    this.tabRoot = tabRoot;
    this.panel = new FitTestPanel(panelRoot);
    this.panel.hide();
    this.protocolSelect = tabRoot.querySelector<HTMLSelectElement>('#ft-protocol')!;
    for (const p of DEFAULT_PROTOCOLS) {
      const opt = document.createElement('option');
      opt.value = p.displayName;
      opt.textContent = p.displayName;
      this.protocolSelect.appendChild(opt);
    }
    this.protocolSummary = tabRoot.querySelector<HTMLElement>('[data-current-protocol]');
    this.refreshProtocolSummary();
    this.protocolSelect.addEventListener('change', () => this.refreshProtocolSummary());
    this.personName = required<HTMLInputElement>(tabRoot, '#ft-name');
    this.personId = required<HTMLInputElement>(tabRoot, '#ft-idnumber');
    this.maskModel = required<HTMLInputElement>(tabRoot, '#ft-mask-model');
    this.maskSize = required<HTMLInputElement>(tabRoot, '#ft-mask-size');
    this.maskPassLevel = required<HTMLInputElement>(tabRoot, '#ft-mask-passlevel');
    this.maskN95 = required<HTMLInputElement>(tabRoot, '#ft-mask-n95');
    this.operator = required<HTMLInputElement>(tabRoot, '#ft-operator');
    this.notes = required<HTMLTextAreaElement>(tabRoot, '#ft-notes');
    this.endOnUnachievable = required<HTMLInputElement>(tabRoot, '#ft-end-on-unachievable');
    this.startBtn = required<HTMLButtonElement>(tabRoot, '#ft-start-btn');
    this.abortBtn = required<HTMLButtonElement>(tabRoot, '#ft-abort-btn');

    this.startBtn.addEventListener('click', () => {
      void this.startTest();
    });
    this.abortBtn.addEventListener('click', () => {
      void this.abortTest();
    });
    // Form starts editable so users can pre-fill name/mask before plugging
    // the device in. The Start button is the only thing that gates on the
    // connection.
    this.setFormEnabled(true);
  }

  private refreshProtocolSummary(): void {
    if (this.protocolSummary) {
      this.protocolSummary.textContent = this.protocolSelect.value
        ? `· ${this.protocolSelect.value}`
        : '';
    }
  }

  setStore(store: FitTestStore): void {
    this.store = store;
  }

  setHistoryPanel(panel: FitTestHistoryPanel): void {
    this.history = panel;
  }

  /** Called from main when the Portacount becomes available / unavailable. */
  setPortacount(pc: Portacount | null, info: DeviceInfo | null): void {
    this.pc = pc;
    this.deviceInfo = info;
    // Connection state only gates the Start button — the form stays
    // editable so the user can pre-fill name/mask before plugging in.
    this.setFormEnabled(this.active === null);
    if (!pc) this.panel.hide();
  }

  /** Returns true while a fit test is running. */
  get isRunning(): boolean {
    return this.active !== null;
  }

  /** `enabled` here means "no active test is running". Connection state
   *  is intentionally not consulted for input editability — only the
   *  Start button additionally requires a connected device. */
  private setFormEnabled(enabled: boolean): void {
    for (const el of [
      this.protocolSelect, this.personName, this.personId,
      this.maskModel, this.maskSize, this.maskPassLevel, this.maskN95,
      this.operator, this.notes, this.endOnUnachievable,
    ]) {
      el.disabled = !enabled;
    }
    this.startBtn.disabled = !enabled || this.pc === null;
    this.abortBtn.disabled = enabled || this.active === null;
  }

  private collectForm(): {
    person: FitTestPerson;
    mask: FitTestMask;
    protocol: FitTestProtocolDef;
    start: FitTestStartOptions;
    chosen: NamedProtocol;
  } | null {
    const chosen = DEFAULT_PROTOCOLS.find((p) => p.displayName === this.protocolSelect.value);
    if (!chosen) {
      this.cb.log('fit test: no protocol selected');
      return null;
    }
    // Name + ID are optional up front — the user can label the record
    // after the test runs. ID falls back to '0' since the protocol
    // record expects a numeric-looking string. The single Name field
    // splits on first whitespace into first/last for the device record
    // (the device wants them separate, but the operator doesn't need to
    // think about it).
    const notes = this.notes.value.trim();
    const { firstName, lastName } = splitName(this.personName.value);
    const person: FitTestPerson = {
      firstName,
      lastName,
      idNumber: this.personId.value.trim() || '0',
    };
    if (notes) person.note = notes;
    const passLevel = parseInt(this.maskPassLevel.value, 10);
    if (!Number.isFinite(passLevel) || passLevel <= 0) {
      this.cb.log('fit test: invalid mask pass level');
      return null;
    }
    const mask: FitTestMask = {
      model: this.maskModel.value.trim() || 'unknown',
      passLevel,
      n95Enable: this.maskN95.checked,
    };
    const start: FitTestStartOptions = {
      maskSize: this.maskSize.value.trim() || 'M',
      operator: this.operator.value.trim() || 'webapp',
      endOnOverallFFUnachievable: this.endOnUnachievable.checked,
    };
    // Clone the chosen protocol but flip N95 to match the mask selection
    // (the mask record is the authoritative source for the protocol's
    // N95ENABLE flag).
    const protocol: FitTestProtocolDef = {
      ...chosen,
      n95Enable: mask.n95Enable,
    };
    return { person, mask, protocol, start, chosen };
  }

  private async startTest(): Promise<void> {
    if (!this.pc || !this.deviceInfo) {
      this.cb.log('fit test: not connected');
      return;
    }
    if (this.active) return;
    const collected = this.collectForm();
    if (!collected) return;
    const { person, mask, protocol, start, chosen } = collected;
    this.panel.reset();
    this.panel.show();
    this.cb.onTestStarted();
    this.setFormEnabled(false);
    this.abortBtn.disabled = false;

    let testId = 0;
    let historyHandle: ActiveFitTestHandle | null = null;
    if (this.store) {
      try {
        testId = await this.store.startTest({
          deviceSn: this.deviceInfo.serialNumber,
          deviceModel: this.deviceInfo.modelNumber,
          deviceBuild: this.deviceInfo.buildString,
          person, mask, protocol, start,
        });
        if (this.history) {
          historyHandle = this.history.beginActive({
            startedAt: testId,
            deviceSn: this.deviceInfo.serialNumber,
            deviceModel: this.deviceInfo.modelNumber,
            deviceBuild: this.deviceInfo.buildString,
            person, mask, protocol, start,
          });
        }
      } catch (err) {
        this.cb.log(`fit test: store.startTest: ${(err as Error).message}`);
      }
    }

    const runner = new FitTestRunner(this.pc, {
      onStatusUpdate: (s) => this.panel.update(s, { protocolName: chosen.displayName }),
      onSample: (s) => {
        const sample = {
          testId,
          t: s.t,
          amb: s.amb,
          mask: s.mask,
          ambStatus: s.ambStatus,
          maskStatus: s.maskStatus,
        };
        // Live-paint the placeholder card so the chart fills in as the
        // test runs — matches the sampling UI's behavior.
        historyHandle?.appendSample(sample);
        if (this.store && testId > 0) {
          this.store.recordSample(sample).catch((err) =>
            this.cb.log(`fit test: recordSample: ${(err as Error).message}`),
          );
        }
      },
      onExerciseCompleted: (r) => {
        this.cb.log(`[ex ${r.index + 1}] ${r.name} FF=${r.fitFactor ?? 'n/a'} ${r.status}`);
      },
      onOverallResult: (ff, status) => {
        this.cb.log(`Fit test result: FF=${ff ?? 'n/a'} ${status}`);
      },
    }, (msg) => this.cb.log(msg));

    this.active = { testId, runner, historyHandle };

    try {
      const result = await runner.run({
        person, mask, protocol, start,
        deviceModel: this.deviceInfo.modelNumber || protocol.model,
      });
      if (this.store && testId > 0) {
        await this.store.endTest(testId, Date.now(), {
          ffOverall: result.ffOverall,
          ffOverallStatus: result.ffOverallStatus,
          error: result.error,
          exercises: result.exercises,
        });
      }
    } catch (err) {
      this.cb.log(`fit test failed: ${(err as Error).message}`);
      if (this.store && testId > 0) {
        await this.store.endTest(testId, Date.now(), undefined, (err as Error).message);
      }
    } finally {
      if (historyHandle && testId > 0) {
        try { await historyHandle.finalize(testId); } catch (err) {
          this.cb.log(`fit test: history finalize: ${(err as Error).message}`);
        }
      }
      this.active = null;
      this.cb.onTestEnded();
      this.setFormEnabled(this.pc !== null);
    }
  }

  private async abortTest(): Promise<void> {
    if (!this.active) return;
    this.cb.log('fit test: abort requested');
    this.abortBtn.disabled = true;
    try {
      await this.active.runner.abort();
    } catch (err) {
      this.cb.log(`fit test abort: ${(err as Error).message}`);
    }
  }
}

function required<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const el = root.querySelector(selector);
  if (!el) throw new Error(`missing element ${selector} in fit-test form`);
  return el as T;
}

/** Split a free-form "Name" string into firstName/lastName for the
 *  device record. First whitespace-delimited token is firstName; the
 *  remainder is lastName. A single token (or empty input) lands entirely
 *  in firstName with lastName empty. */
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
