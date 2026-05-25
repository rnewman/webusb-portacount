/**
 * Observer-style fit-test runner for the PortaCount 8020.
 *
 * The 8020 runs fit tests on the device itself — sequencing, timing,
 * pass/fail evaluation, and exercise progression are all internal.
 * The host is a data sink: it watches the line stream, collects per-
 * exercise FF readings, and finalizes a {@link FitTestResult} when
 * the device emits `Overall FF` (success) or `Test Terminated`
 * (early termination).
 *
 * This shape is intentionally different from the 8030 runner, which
 * drives the test via XML commands (NEW_TEMP_DB / PEOPLE / RESPIRATOR
 * / PROTOCOL / FITTEST_START + polling). The 8020 cannot be driven
 * that way over the wire; the user starts the test on the device.
 *
 * The runner is created with a {@link Portacount8020} and a callback
 * bundle. Call `start()` to begin watching (clears any prior partial
 * state); the runner subscribes to the client's parsed-event stream.
 * It does not own the device — it is observation-only.
 */

import type { Portacount8020, Unsubscribe } from './client';
import type { ParsedEvent, UnknownLine } from './parser';

export type ExerciseResultLabel8020 = 'PASS' | 'FAIL' | string;

export interface ExerciseResult8020 {
  exerciseNumber: number;
  fitFactor: number;
  result: ExerciseResultLabel8020;
}

export interface FitTestResult8020 {
  deviceModel: '8020';
  /** Set when the device emitted `NEW TEST PASS = N`. null if the
   * test was already in progress before the runner attached. */
  passLevel: number | null;
  exercises: ExerciseResult8020[];
  /** null if the device terminated before emitting Overall FF. */
  overallFitFactor: number | null;
  /** Raw pass/fail label as emitted by the device. */
  overallResult: ExerciseResultLabel8020 | null;
  /** How the test ended. */
  terminalReason: 'complete' | 'terminated';
  /** Wall-clock ms (Date.now()) when NEW TEST PASS was observed.
   * null if the test was already in progress when the runner
   * attached. */
  startedAt: number | null;
  /** Wall-clock ms (Date.now()) at terminal event. */
  endedAt: number;
}

export interface AmbientMaskSample {
  /** Milliseconds since `start()` was called. */
  t: number;
  ambient: number | null;
  mask: number | null;
}

export interface FitTestRunnerCallbacks8020 {
  onNewTest?: (passLevel: number) => void;
  onExerciseCompleted?: (result: ExerciseResult8020) => void;
  onSample?: (sample: AmbientMaskSample) => void;
  onResult?: (result: FitTestResult8020) => void;
  onLowParticleWarning?: () => void;
}

export type FitTestRunner8020State = 'idle' | 'watching' | 'completed';

/**
 * Watches the client's parsed-event stream and assembles a
 * {@link FitTestResult8020} on completion.
 *
 * The runner persists across multiple fit tests: after `onResult`
 * fires, it returns to `watching` and is ready to assemble the next
 * test. Call `stop()` to detach.
 */
export class FitTestRunner8020 {
  private state: FitTestRunner8020State = 'idle';
  private unsubscribe: Unsubscribe | null = null;
  private startWall = 0;

  // In-progress accumulators.
  private passLevel: number | null = null;
  private exercises: ExerciseResult8020[] = [];
  private startedAt: number | null = null;
  private lastAmbient: number | null = null;
  private lastMask: number | null = null;

  constructor(
    private client: Portacount8020,
    private callbacks: FitTestRunnerCallbacks8020 = {},
  ) {}

  /** Begin watching the client's parsed-event stream. Idempotent —
   * calling twice does nothing the second time. */
  start(): void {
    if (this.state !== 'idle') return;
    this.startWall = Date.now();
    this.unsubscribe = this.client.onEvent((ev) => this.handleEvent(ev));
    this.state = 'watching';
  }

  /** Detach from the client. The runner can be `start()`ed again. */
  stop(): void {
    if (this.state === 'idle') return;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.resetProgress();
    this.state = 'idle';
  }

  get current(): FitTestRunner8020State {
    return this.state;
  }

  private handleEvent(event: ParsedEvent | UnknownLine): void {
    switch (event.kind) {
      case 'new-test-pass':
        this.resetProgress();
        this.passLevel = event.passLevel;
        this.startedAt = Date.now();
        this.callbacks.onNewTest?.(event.passLevel);
        return;
      case 'ambient-reading':
        this.lastAmbient = event.concentration;
        this.callbacks.onSample?.({
          t: Date.now() - this.startWall,
          ambient: this.lastAmbient,
          mask: this.lastMask,
        });
        return;
      case 'mask-reading':
        this.lastMask = event.concentration;
        this.callbacks.onSample?.({
          t: Date.now() - this.startWall,
          ambient: this.lastAmbient,
          mask: this.lastMask,
        });
        return;
      case 'exercise-ff': {
        const result: ExerciseResult8020 = {
          exerciseNumber: event.exerciseNumber,
          fitFactor: event.fitFactor,
          result: event.result,
        };
        this.exercises.push(result);
        this.callbacks.onExerciseCompleted?.(result);
        return;
      }
      case 'overall-ff':
        this.finalize('complete', event.fitFactor, event.result);
        return;
      case 'test-terminated':
        this.finalize('terminated', null, null);
        return;
      case 'low-particle-count':
        this.callbacks.onLowParticleWarning?.();
        return;
      default:
        return;
    }
  }

  private finalize(
    reason: 'complete' | 'terminated',
    overallFitFactor: number | null,
    overallResult: ExerciseResultLabel8020 | null,
  ): void {
    const result: FitTestResult8020 = {
      deviceModel: '8020',
      passLevel: this.passLevel,
      exercises: this.exercises,
      overallFitFactor,
      overallResult,
      terminalReason: reason,
      startedAt: this.startedAt,
      endedAt: Date.now(),
    };
    this.callbacks.onResult?.(result);
    this.resetProgress();
  }

  private resetProgress(): void {
    this.passLevel = null;
    this.exercises = [];
    this.startedAt = null;
    this.lastAmbient = null;
    this.lastMask = null;
  }
}
