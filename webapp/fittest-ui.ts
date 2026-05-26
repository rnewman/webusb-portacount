/**
 * Glue between the fit-test form, the FitTestRunner, the progress panel,
 * and the IDB store. Keeps `main.ts` from drowning in fit-test wiring.
 */

import {
  FitTestRunner,
  runHostDrivenFitTest,
  FitTestAbortedError8020,
  type DeviceInfo,
  type ExerciseSnapshot,
  type ExerciseStatus,
  type FitTestMask,
  type FitTestPerson,
  type FitTestProtocolDef,
  type FitTestResult,
  type FitTestRunnerCallbacks,
  type FitTestStartOptions,
  type FitTestStatus,
  type Portacount,
  type Portacount8020,
} from 'webusb-portacount';

import { protocolsForDevice, type NamedProtocol } from './fittest-defaults';
import { FitTestPanel } from './fittest-panel';
import type { FitTestStore } from './fittest-store';
import {
  downloadBlob,
  personLabel,
  type ActiveFitTestHandle,
  type FitTestHistoryPanel,
} from './fittest-history-panel';

export interface FitTestUiCallbacks {
  log: (msg: string) => void;
  /** Called whenever a run starts; the host should disable
   * sampling-related UI until `onTestEnded`. */
  onTestStarted: () => void;
  onTestEnded: () => void;
}

interface ActiveRun {
  testId: number;
  historyHandle: ActiveFitTestHandle | null;
  /** Set when an 8030 FitTestRunner is in flight. */
  runner: FitTestRunner | null;
  /** Set when a host-driven 8020 test is in flight. */
  abort8020: AbortController | null;
}

export type DeviceMode = '8030' | '8020';

interface DebugCapture {
  record: (kind: string, payload: Record<string, unknown>) => void;
  finalize: () => void;
}

export class FitTestUi {
  private panel: FitTestPanel;
  private store: FitTestStore | null = null;
  private history: FitTestHistoryPanel | null = null;
  private pc: Portacount | null = null;
  private deviceInfo: DeviceInfo | null = null;
  private pc8020: Portacount8020 | null = null;
  private deviceMode: DeviceMode = '8030';
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
  private maskType: HTMLSelectElement;
  private maskSize: HTMLInputElement;
  private maskPassLevel: HTMLInputElement;
  private maskN95: HTMLInputElement;
  private operator: HTMLInputElement;
  private notes: HTMLTextAreaElement;
  private endOnUnachievable: HTMLInputElement;
  private debugCapture: HTMLInputElement;

  constructor(tabRoot: HTMLElement, panelRoot: HTMLElement, cb: FitTestUiCallbacks) {
    this.cb = cb;
    this.tabRoot = tabRoot;
    this.panel = new FitTestPanel(panelRoot);
    this.panel.hide();
    this.protocolSelect = tabRoot.querySelector<HTMLSelectElement>('#ft-protocol')!;
    this.populateProtocols();
    this.protocolSummary = tabRoot.querySelector<HTMLElement>('[data-current-protocol]');
    this.refreshProtocolSummary();
    this.protocolSelect.addEventListener('change', () => this.refreshProtocolSummary());
    this.personName = required<HTMLInputElement>(tabRoot, '#ft-name');
    this.personId = required<HTMLInputElement>(tabRoot, '#ft-idnumber');
    this.maskModel = required<HTMLInputElement>(tabRoot, '#ft-mask-model');
    this.maskType = required<HTMLSelectElement>(tabRoot, '#ft-mask-type');
    this.maskSize = required<HTMLInputElement>(tabRoot, '#ft-mask-size');
    this.maskPassLevel = required<HTMLInputElement>(tabRoot, '#ft-mask-passlevel');
    this.maskN95 = required<HTMLInputElement>(tabRoot, '#ft-mask-n95');
    this.operator = required<HTMLInputElement>(tabRoot, '#ft-operator');
    this.notes = required<HTMLTextAreaElement>(tabRoot, '#ft-notes');
    this.endOnUnachievable = required<HTMLInputElement>(tabRoot, '#ft-end-on-unachievable');
    this.startBtn = required<HTMLButtonElement>(tabRoot, '#ft-start-btn');
    this.abortBtn = required<HTMLButtonElement>(tabRoot, '#ft-abort-btn');
    // #ft-debug-capture lives in the debug gutter (outside the tab
    // panel), so look it up from document rather than tabRoot.
    const dbg = document.getElementById('ft-debug-capture');
    if (!dbg) throw new Error('missing #ft-debug-capture in document');
    this.debugCapture = dbg as HTMLInputElement;

    this.startBtn.addEventListener('click', () => {
      void this.startTest();
    });
    this.abortBtn.addEventListener('click', () => {
      void this.abortTest();
    });

    // Mask-type dropdown drives the pass-level field. Pass level is a
    // property of the mask *class* per OSHA (half-mask 100, full-face
    // 500, etc.); the N95 checkbox is orthogonal (it's a device-side
    // measurement flag for N95 filter material). "custom" is the
    // escape hatch — leaves the current value alone.
    this.maskType.addEventListener('change', () => {
      const pl = passLevelForMaskType(this.maskType.value);
      if (pl !== null) this.maskPassLevel.value = String(pl);
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

  private populateProtocols(): void {
    const prev = this.protocolSelect.value;
    const protocols = protocolsForDevice(this.deviceMode);
    this.protocolSelect.replaceChildren();
    for (const p of protocols) {
      const opt = document.createElement('option');
      opt.value = p.displayName;
      opt.textContent = p.displayName;
      this.protocolSelect.appendChild(opt);
    }
    // Restore prior selection if still valid; otherwise default to the
    // first entry.
    if (prev && protocols.some((p) => p.displayName === prev)) {
      this.protocolSelect.value = prev;
    }
  }

  /** Switch between 8030 and 8020 modes. Repopulates the protocol
   * dropdown and updates which client/info the Start button targets. */
  setDeviceMode(mode: DeviceMode): void {
    if (this.deviceMode === mode) return;
    this.deviceMode = mode;
    this.populateProtocols();
    this.refreshProtocolSummary();
    this.refreshStartButton();
  }

  get currentDeviceMode(): DeviceMode {
    return this.deviceMode;
  }

  setStore(store: FitTestStore): void {
    this.store = store;
  }

  setHistoryPanel(panel: FitTestHistoryPanel): void {
    this.history = panel;
  }

  /** Called from main when the 8030 Portacount becomes available /
   * unavailable. */
  setPortacount(pc: Portacount | null, info: DeviceInfo | null): void {
    this.pc = pc;
    this.deviceInfo = info;
    if (!pc && this.active?.runner) {
      this.active.runner.abort().catch(() => undefined);
    }
    this.setFormEnabled(this.active === null);
    if (!pc && this.deviceMode === '8030') this.panel.hide();
  }

  /** Called from main when the 8020 client becomes available /
   * unavailable. */
  setPortacount8020(client: Portacount8020 | null): void {
    this.pc8020 = client;
    if (!client && this.active?.abort8020) {
      this.active.abort8020.abort(new Error('client disconnected'));
    }
    this.setFormEnabled(this.active === null);
    if (!client && this.deviceMode === '8020') this.panel.hide();
  }

  private refreshStartButton(): void {
    const haveClient = this.deviceMode === '8030' ? this.pc !== null : this.pc8020 !== null;
    this.startBtn.disabled = this.active !== null || !haveClient;
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
      this.maskModel, this.maskType, this.maskSize, this.maskPassLevel, this.maskN95,
      this.operator, this.notes, this.endOnUnachievable,
    ]) {
      el.disabled = !enabled;
    }
    const haveClient = this.deviceMode === '8030' ? this.pc !== null : this.pc8020 !== null;
    this.startBtn.disabled = !enabled || !haveClient;
    this.abortBtn.disabled = enabled || this.active === null;
    this.cb.log(
      `fit test: setFormEnabled(${enabled}) → mode=${this.deviceMode} ` +
      `pc=${this.pc !== null} pc8020=${this.pc8020 !== null} ` +
      `startBtn.disabled=${this.startBtn.disabled}`,
    );
  }

  private collectForm(): {
    person: FitTestPerson;
    mask: FitTestMask;
    protocol: FitTestProtocolDef;
    start: FitTestStartOptions;
    chosen: NamedProtocol;
  } | null {
    const chosen = protocolsForDevice(this.deviceMode).find(
      (p) => p.displayName === this.protocolSelect.value,
    );
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
    if (this.active) {
      this.cb.log('fit test: a run is already in progress');
      return;
    }
    const haveClient = this.deviceMode === '8030'
      ? this.pc !== null
      : this.pc8020 !== null;
    this.cb.log(
      `fit test: Start clicked (mode=${this.deviceMode}, haveClient=${haveClient}, protocol="${this.protocolSelect.value}")`,
    );
    const collected = this.collectForm();
    if (!collected) return;
    if (this.deviceMode === '8020') {
      await this.startTest8020(collected);
    } else {
      await this.startTest8030(collected);
    }
  }

  private async startTest8030(collected: NonNullable<ReturnType<typeof this.collectForm>>): Promise<void> {
    if (!this.pc || !this.deviceInfo) {
      this.cb.log('fit test: not connected (8030)');
      return;
    }
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

    const debug = this.debugCapture.checked
      ? this.openDebugCapture({ person, mask, protocol, start, chosen })
      : null;

    const runner = new FitTestRunner(this.pc, {
      onStatusUpdate: (s) => {
        this.panel.update(s, { protocolName: chosen.displayName });
        historyHandle?.updateStatus(s);
        debug?.record('status', { status: s });
      },
      onSample: (s) => {
        const sample = {
          testId,
          t: s.t,
          amb: s.amb,
          mask: s.mask,
          ambStatus: s.ambStatus,
          maskStatus: s.maskStatus,
          exerciseNumber: s.exerciseNumber,
          phase: s.phase,
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
        debug?.record('exercise-completed', { exercise: r });
      },
      onOverallResult: (ff, status) => {
        this.cb.log(`Fit test result: FF=${ff ?? 'n/a'} ${status}`);
      },
    }, (msg) => this.cb.log(msg));

    this.active = { testId, runner, historyHandle, abort8020: null };

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
      debug?.record('run-end', { ok: true, result });
    } catch (err) {
      this.cb.log(`fit test failed: ${(err as Error).message}`);
      if (this.store && testId > 0) {
        await this.store.endTest(testId, Date.now(), undefined, (err as Error).message);
      }
      debug?.record('run-end', { ok: false, error: (err as Error).message });
    } finally {
      if (historyHandle && testId > 0) {
        try { await historyHandle.finalize(testId); } catch (err) {
          this.cb.log(`fit test: history finalize: ${(err as Error).message}`);
        }
      }
      debug?.finalize();
      this.active = null;
      this.cb.onTestEnded();
      this.setFormEnabled(true);
    }
  }

  private async startTest8020(
    collected: NonNullable<ReturnType<typeof this.collectForm>>,
  ): Promise<void> {
    if (!this.pc8020) {
      this.cb.log('fit test: not connected (8020)');
      return;
    }
    const client = this.pc8020;
    const { person, mask, protocol, start, chosen } = collected;
    this.panel.reset();
    this.panel.show();
    this.cb.onTestStarted();
    this.setFormEnabled(false);
    this.abortBtn.disabled = false;

    // Storage write — schema is identical to 8030 because the user
    // wanted "exact same storage". The deviceModel marker is the only
    // discriminator.
    const deviceSn = client.snapshot.settings.serialNumber ?? 'unknown';
    let testId = 0;
    let historyHandle: ActiveFitTestHandle | null = null;
    if (this.store) {
      try {
        testId = await this.store.startTest({
          deviceSn,
          deviceModel: '8020',
          deviceBuild: client.identity.firmwareVersion ?? '',
          person, mask, protocol, start,
        });
        if (this.history) {
          historyHandle = this.history.beginActive({
            startedAt: testId,
            deviceSn,
            deviceModel: '8020',
            deviceBuild: client.identity.firmwareVersion ?? '',
            person, mask, protocol, start,
          });
        }
      } catch (err) {
        this.cb.log(`fit test (8020): store.startTest: ${(err as Error).message}`);
      }
    }

    // Per-exercise expected duration in seconds (used to compute
    // progressPercent in synthesized status snapshots).
    const perExerciseSec = (ex: { maskSampleSec: number }) =>
      protocol.ambientPurgeSec + protocol.ambientSampleSec +
      protocol.maskPurgeSec + ex.maskSampleSec;
    const totalSec = protocol.exercises.reduce((acc, e) => acc + perExerciseSec(e), 0);
    const runStartedAt = Date.now();

    // FitTestStatus synth state. We build a fresh snapshot on each
    // phase transition / sample / exercise completion and call
    // onStatusUpdate so the FitTestPanel + history card keep
    // rendering exactly as they do for 8030.
    const completedExercises = new Map<number, { ff: number; status: 'PASS' | 'FAIL' }>();
    let currentPhase: string = 'IDLE';
    let currentExerciseIdx = 0; // 0-based
    let phaseStartedAt = runStartedAt;
    let lastAmb = 0;
    let lastMask = 0;
    let ambStatus: 'PASS' | 'FAIL' | 'TESTING' | undefined;
    let maskStatus: 'PASS' | 'FAIL' | 'TESTING' | undefined;

    const buildStatus = (): FitTestStatus => {
      const elapsedSec = (Date.now() - runStartedAt) / 1000;
      const phaseElapsedSec = (Date.now() - phaseStartedAt) / 1000;
      const exercises: ExerciseSnapshot[] = [];
      for (let i = 0; i < 12; i++) {
        const proto = protocol.exercises[i];
        if (!proto) {
          exercises.push({ index: i, name: '', fitFactor: null, status: 'NOT_STARTED', excluded: false });
          continue;
        }
        const done = completedExercises.get(i);
        let status: ExerciseStatus = 'NOT_STARTED';
        if (done) status = done.status;
        else if (i === currentExerciseIdx && currentPhase !== 'IDLE') status = 'TESTING';
        if (proto.excluded) status = 'EXCLUDED';
        exercises.push({
          index: i,
          name: proto.name,
          fitFactor: done?.ff ?? null,
          status,
          excluded: proto.excluded,
        });
      }
      return {
        newData: new Date().toISOString(),
        ffOverall: null,
        status: currentPhase,
        done: false,
        progressPercent: Math.min(100, Math.round((elapsedSec / totalSec) * 100)),
        exerciseNumber: currentExerciseIdx,
        ffPassLevel: mask.passLevel,
        ambConc: lastAmb,
        ambConcStatus: ambStatus,
        maskConc: lastMask,
        maskConcStatus: maskStatus,
        seconds: Math.round(phaseElapsedSec),
        totalSeconds: Math.round(elapsedSec),
        lowAlcoholWarning: false,
        lowParticleWarning: false,
        exercises,
        raw: {},
      };
    };

    const emitStatus = () => {
      const s = buildStatus();
      this.panel.update(s, { protocolName: chosen.displayName });
      historyHandle?.updateStatus(s);
    };

    const ac = new AbortController();
    this.active = { testId, runner: null, historyHandle, abort8020: ac };

    let result8020: Awaited<ReturnType<typeof runHostDrivenFitTest>> | null = null;
    let runError: Error | null = null;
    try {
      result8020 = await runHostDrivenFitTest(
        client,
        {
          exercises: protocol.exercises.map((e) => ({
            name: e.name,
            maskSampleSec: e.maskSampleSec,
            excluded: e.excluded,
          })),
          ambientPurgeSec: protocol.ambientPurgeSec,
          ambientSampleSec: protocol.ambientSampleSec,
          maskPurgeSec: protocol.maskPurgeSec,
          passLevel: mask.passLevel,
          signal: ac.signal,
        },
        {
          onPhaseStart: (info) => {
            currentExerciseIdx = info.exerciseNumber - 1;
            currentPhase =
              info.phase === 'ambient-purge' ? 'AMBIENT_PURGE'
              : info.phase === 'ambient-sample' ? 'AMBIENT_SAMPLE'
              : info.phase === 'mask-purge' ? 'MASK_PURGE'
              : 'MASK_SAMPLE';
            phaseStartedAt = Date.now();
            ambStatus = info.phase.startsWith('ambient') ? 'TESTING' : undefined;
            maskStatus = info.phase.startsWith('mask') ? 'TESTING' : undefined;
            emitStatus();
          },
          onSample: (s) => {
            if (s.phase.startsWith('ambient')) lastAmb = s.concentration;
            else lastMask = s.concentration;
            emitStatus();
            // Store per-sample so the chart renders. testId>0 if the
            // store accepted startTest().
            const sample = {
              testId,
              t: Date.now() - runStartedAt,
              amb: lastAmb,
              mask: lastMask,
              ambStatus,
              maskStatus,
              exerciseNumber: currentExerciseIdx,
              phase: currentPhase,
            };
            historyHandle?.appendSample(sample);
            if (this.store && testId > 0) {
              this.store.recordSample(sample).catch((err) =>
                this.cb.log(`fit test (8020): recordSample: ${(err as Error).message}`),
              );
            }
          },
          onExerciseCompleted: (r) => {
            const idx = r.exerciseNumber - 1;
            completedExercises.set(idx, {
              ff: r.fitFactor,
              status: r.result === 'PASS' ? 'PASS' : 'FAIL',
            });
            this.cb.log(`[ex ${r.exerciseNumber}] ${protocol.exercises[idx]?.name ?? ''} FF=${r.fitFactor.toFixed(1)} ${r.result}`);
            emitStatus();
          },
        },
      );
    } catch (err) {
      runError = err as Error;
    }

    // Final result write to the store, mirroring the 8030 path.
    const ffOverall = result8020?.overallFitFactor ?? null;
    const ffOverallStatus = result8020?.overallResult === 'PASS' ? 'PASS'
      : result8020?.overallResult === 'FAIL' ? 'FAIL'
      : undefined;
    const exerciseResults: FitTestResult['exercises'] = (result8020?.exercises ?? []).map((e) => {
      const idx = e.exerciseNumber - 1;
      return {
        index: idx,
        name: protocol.exercises[idx]?.name ?? '',
        fitFactor: Number.isFinite(e.fitFactor) ? e.fitFactor : null,
        status: e.result === 'PASS' ? 'PASS' : e.result === 'FAIL' ? 'FAIL' : 'PASS',
      };
    });
    const errMsg = runError && !(runError instanceof FitTestAbortedError8020)
      ? runError.message
      : runError instanceof FitTestAbortedError8020
        ? 'aborted'
        : undefined;
    if (this.store && testId > 0) {
      try {
        await this.store.endTest(testId, Date.now(), {
          ffOverall,
          ffOverallStatus,
          error: errMsg,
          exercises: exerciseResults,
        }, errMsg);
      } catch (err) {
        this.cb.log(`fit test (8020): store.endTest: ${(err as Error).message}`);
      }
    }
    if (runError && !(runError instanceof FitTestAbortedError8020)) {
      this.cb.log(`fit test (8020) failed: ${runError.message}`);
    } else if (runError instanceof FitTestAbortedError8020) {
      this.cb.log('fit test (8020): aborted');
    } else {
      this.cb.log(`Fit test (8020) result: FF=${ffOverall ?? 'n/a'} ${ffOverallStatus ?? ''}`);
    }

    // Final status snapshot — sets done:true so the panel collapses.
    {
      const final = buildStatus();
      final.done = true;
      final.ffOverall = ffOverall;
      if (ffOverallStatus) final.ffOverallStatus = ffOverallStatus;
      if (errMsg) final.error = errMsg;
      this.panel.update(final, { protocolName: chosen.displayName });
      historyHandle?.updateStatus(final);
    }

    if (historyHandle && testId > 0) {
      try { await historyHandle.finalize(testId); } catch (err) {
        this.cb.log(`fit test (8020): history finalize: ${(err as Error).message}`);
      }
    }
    this.active = null;
    this.cb.onTestEnded();
    this.setFormEnabled(true);
  }

  /** Open a per-run debug capture. Returns a handle whose `record()` is
   *  called from the runner callbacks; `finalize()` unsubscribes the
   *  wire tap and downloads the JSONL. */
  private openDebugCapture(meta: {
    person: FitTestPerson;
    mask: FitTestMask;
    protocol: FitTestProtocolDef;
    start: FitTestStartOptions;
    chosen: NamedProtocol;
  }): DebugCapture {
    const t0 = Date.now();
    const events: string[] = [];
    const record = (kind: string, payload: Record<string, unknown>): void => {
      events.push(JSON.stringify({ t: Date.now() - t0, kind, ...payload }));
    };
    record('run-meta', {
      startedAt: new Date(t0).toISOString(),
      device: this.deviceInfo ? {
        serialNumber: this.deviceInfo.serialNumber,
        modelNumber: this.deviceInfo.modelNumber,
        buildString: this.deviceInfo.buildString,
      } : null,
      person: meta.person,
      mask: meta.mask,
      protocol: { ...meta.protocol, displayName: meta.chosen.displayName },
      start: meta.start,
    });
    const unsubscribe = this.pc?.addXmlTrace({
      onTx: (xml) => record('tx', { xml }),
      onRx: (xml) => record('rx', { xml }),
    }) ?? (() => {});
    return {
      record,
      finalize: () => {
        unsubscribe();
        const body = events.join('\n') + '\n';
        const who = personLabel(meta.person) || 'unlabeled';
        const ts = new Date(t0).toISOString().replace(/[:T]/g, '-').slice(0, 19);
        downloadBlob(body, `fittest-debug_${who}_${ts}.jsonl`, 'application/x-ndjson');
      },
    };
  }

  private async abortTest(): Promise<void> {
    if (!this.active) return;
    this.cb.log('fit test: abort requested');
    this.abortBtn.disabled = true;
    try {
      if (this.active.runner) {
        await this.active.runner.abort();
      } else if (this.active.abort8020) {
        this.active.abort8020.abort(new Error('aborted by user'));
      }
    } catch (err) {
      this.cb.log(`fit test abort: ${(err as Error).message}`);
    }
  }
}

/** Map a mask-type dropdown value to the OSHA-standard FF threshold for
 *  that mask class. Returns null for "custom" so the caller leaves the
 *  current pass-level value alone. */
function passLevelForMaskType(value: string): number | null {
  switch (value) {
    case 'half': return 100;
    case 'full': return 500;
    case 'papr-tight': return 500;
    case 'papr-loose': return 25;
    case 'custom': return null;
    default: return null;
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
