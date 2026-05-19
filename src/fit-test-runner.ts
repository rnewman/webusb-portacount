/**
 * Runs an end-to-end fit test on a connected Portacount 8030.
 *
 * The 8030 owns the test loop itself: we push three database records
 * (person, mask, protocol) into the device's temp DB, send the atomic
 * FITTEST/START write, then poll FITTEST/ALL every ~333 ms until DONE.
 * This class wraps that lifecycle, parses each poll into a strict
 * {@link FitTestStatus}, and emits derived events (per-exercise
 * completion, overall result) by diffing successive snapshots.
 *
 * Concurrency: this class assumes it owns the `Portacount` while a run
 * is in flight. Other callers may still issue commands (e.g. the
 * connection-level keep-alive) — `Portacount.command()` serializes them
 * for us — but anyone else trying to START or STOP the fit-test will
 * conflict at the device level.
 */

import type { Portacount } from './portacount';
import {
  buildNewTempDbXml,
  buildPersonXml,
  buildPollXml,
  buildProtocolXml,
  buildRespiratorXml,
  buildStartXml,
  buildStopXml,
  diffFitTestStatus,
  parseFitTestStatus,
} from './fit-test-protocol';
import type {
  ExerciseResult,
  FitTestAbortReason,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestResult,
  FitTestRunnerCallbacks,
  FitTestRunnerOptions,
  FitTestRunnerState,
  FitTestStartOptions,
  FitTestStatus,
} from './fit-test-types';

const DEFAULT_POLL_INTERVAL_MS = 333;
const DEFAULT_POLL_TIMEOUT_MS = 3000;
const DEFAULT_PRIME_TIMEOUT_MS = 5000;
const DEFAULT_POST_ABORT_POLL_MS = 2000;

export interface FitTestRunArgs {
  person: FitTestPerson;
  mask: FitTestMask;
  protocol: FitTestProtocolDef;
  start: FitTestStartOptions;
  /** From `Portacount.connect()` → `DeviceInfo.modelNumber`. Written
   * into the PROTOCOL/MODEL record. */
  deviceModel: string;
}

export class FitTestRunner {
  private pc: Portacount;
  private callbacks: FitTestRunnerCallbacks;
  private logFn: (msg: string) => void;
  private opts: Required<FitTestRunnerOptions>;

  private _state: FitTestRunnerState = 'idle';
  private prevStatus: FitTestStatus | null = null;
  private runStartedAt = 0;
  private hasSeenNonIdle = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private postAbortDeadline = 0;
  private resolveRun: ((r: FitTestResult) => void) | null = null;
  private rejectRun: ((err: Error) => void) | null = null;
  /** Error to surface to the caller when we finalize after abort. */
  private finalizeError: FitTestAbortReason | null = null;
  /** Promise the in-flight `run()` is bound to — used so `abort()` can
   * await its completion. */
  private runPromise: Promise<FitTestResult> | null = null;

  constructor(
    pc: Portacount,
    callbacks: FitTestRunnerCallbacks = {},
    logFn: (msg: string) => void = () => {},
    options: FitTestRunnerOptions = {},
  ) {
    this.pc = pc;
    this.callbacks = callbacks;
    this.logFn = logFn;
    this.opts = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs: options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
      primeTimeoutMs: options.primeTimeoutMs ?? DEFAULT_PRIME_TIMEOUT_MS,
      resetDeviceState: options.resetDeviceState ?? true,
      resetTempDb: options.resetTempDb ?? true,
      treatIdleAsDone: options.treatIdleAsDone ?? true,
      postAbortPollMs: options.postAbortPollMs ?? DEFAULT_POST_ABORT_POLL_MS,
    };
  }

  get state(): FitTestRunnerState {
    return this._state;
  }

  /**
   * Run a fit test. Resolves with the final result when the device
   * reports DONE (or transitions to IDLE after we've seen activity).
   * Rejects on transport error, abort, or device-reported failure.
   *
   * Throws synchronously if called while a previous run is active.
   */
  run(args: FitTestRunArgs): Promise<FitTestResult> {
    if (this._state !== 'idle' && this._state !== 'completed' && this._state !== 'failed') {
      throw new Error(`run: runner busy (state=${this._state})`);
    }
    this.resetForRun();
    this.runStartedAt = Date.now();

    this.runPromise = new Promise<FitTestResult>((resolve, reject) => {
      this.resolveRun = resolve;
      this.rejectRun = reject;
    });

    // Kick off the priming -> starting -> polling sequence asynchronously.
    void this.driveRun(args);
    return this.runPromise;
  }

  /**
   * Abort an in-flight test. Sends STOP, polls for up to `postAbortPollMs`
   * to capture the device's final snapshot, then rejects the run-promise
   * with `{ kind: 'user-abort' }`. Safe to call from any state.
   */
  async abort(): Promise<void> {
    if (this._state === 'idle' || this._state === 'completed' || this._state === 'failed') {
      return;
    }
    this.finalizeError = { kind: 'user-abort' };
    if (this._state === 'priming' || this._state === 'starting') {
      // Pre-poll. Mark as failing and let the priming/starting path see
      // the cancellation when its current command resolves.
      this._state = 'aborting';
      this.logFn('[fittest] abort during priming/starting — will fail when current command settles');
      return;
    }
    if (this._state === 'polling') {
      this._state = 'aborting';
      this.postAbortDeadline = Date.now() + this.opts.postAbortPollMs;
      this.logFn('[fittest] sending FITTEST/STOP');
      try {
        await this.pc.command(buildStopXml(), this.opts.pollTimeoutMs);
      } catch (err) {
        this.logFn(`[fittest] STOP write failed (continuing): ${(err as Error).message}`);
      }
    }
    if (this.runPromise) {
      // Swallow the rejection here so callers awaiting `abort()` don't
      // see the rejection bubble out — the original `run()` promise
      // still rejects for its owner.
      await this.runPromise.catch(() => undefined);
    }
  }

  // ---- internal ----

  private resetForRun(): void {
    this._state = 'idle';
    this.prevStatus = null;
    this.hasSeenNonIdle = false;
    this.pollInFlight = false;
    this.postAbortDeadline = 0;
    this.finalizeError = null;
    this.resolveRun = null;
    this.rejectRun = null;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async driveRun(args: FitTestRunArgs): Promise<void> {
    try {
      // Priming phase.
      this._state = 'priming';
      const writeTimeout = this.opts.primeTimeoutMs;
      // Send FITTEST/STOP first to reset device state from any prior
      // run. Without this, the device has been observed to silently
      // drop the subsequent NEW_TEMP_DATABASE write — the priming
      // exchange times out with zero bytes back. Errors here are
      // non-fatal: the device may not have an active test to stop.
      if (this.opts.resetDeviceState) {
        this.logFn('[fittest] FITTEST/STOP (state reset)');
        try {
          await this.pc.command(buildStopXml(), writeTimeout);
        } catch (err) {
          this.logFn(`[fittest] pre-priming STOP failed (continuing): ${(err as Error).message}`);
        }
        this.bailIfAborted();
      }
      if (this.opts.resetTempDb) {
        this.logFn('[fittest] NEW_TEMP_DATABASE');
        await this.pc.command(buildNewTempDbXml(), writeTimeout);
        this.bailIfAborted();
      }
      this.logFn('[fittest] writing PEOPLE record');
      await this.pc.command(buildPersonXml(args.person), writeTimeout);
      this.bailIfAborted();
      this.logFn('[fittest] writing RESPIRATOR record');
      await this.pc.command(buildRespiratorXml(args.mask), writeTimeout);
      this.bailIfAborted();
      this.logFn(`[fittest] writing PROTOCOL record ('${args.protocol.name}', ${args.protocol.exercises.length} exercises)`);
      await this.pc.command(buildProtocolXml(args.protocol, args.deviceModel), writeTimeout);
      this.bailIfAborted();

      // Start phase.
      this._state = 'starting';
      this.logFn(`[fittest] FITTEST/START (operator='${args.start.operator}', maskSize='${args.start.maskSize}')`);
      await this.pc.command(buildStartXml(args.start), writeTimeout);
      this.bailIfAborted();

      // Polling.
      this._state = 'polling';
      this.pollTimer = setInterval(() => {
        void this.tick();
      }, this.opts.pollIntervalMs);
      // Also fire the first poll immediately so consumers see status
      // without a 333ms gap.
      void this.tick();
    } catch (err) {
      this.failWith({ kind: 'transport-error', cause: err as Error });
    }
  }

  private bailIfAborted(): void {
    // Called between awaited steps in driveRun(). If `abort()` ran while
    // a command was in flight, throw so the catch in driveRun() routes
    // to failWith(user-abort).
    if ((this._state as FitTestRunnerState) === 'aborting' && this.finalizeError) {
      const e = this.finalizeError;
      // failWith will use this; throw a sentinel to abort the try.
      throw new FitTestAbortedSentinel(e);
    }
  }

  private async tick(): Promise<void> {
    if (this.pollInFlight) return;
    if (this._state !== 'polling' && this._state !== 'aborting') return;
    this.pollInFlight = true;
    try {
      const raw = await this.pc.command(buildPollXml(), this.opts.pollTimeoutMs);
      this.handlePollResponse(raw);
    } catch (err) {
      // A transport-level failure during polling ends the run.
      this.failWith({ kind: 'transport-error', cause: err as Error });
    } finally {
      this.pollInFlight = false;
    }
  }

  private handlePollResponse(raw: string): void {
    let next: FitTestStatus;
    try {
      next = parseFitTestStatus(raw);
    } catch (err) {
      // Malformed device response → treat as device error.
      this.failWith({ kind: 'device-error', detail: `parse: ${(err as Error).message}` });
      return;
    }

    this.callbacks.onStatusUpdate?.(next);

    // Live sample stream.
    if (next.ambConcStatus === 'TESTING' || next.maskConcStatus === 'TESTING') {
      this.callbacks.onSample?.({
        t: Date.now() - this.runStartedAt,
        amb: next.ambConc,
        mask: next.maskConc,
        ambStatus: next.ambConcStatus,
        maskStatus: next.maskConcStatus,
      });
    }

    // Per-exercise completion + DONE detection.
    const diff = diffFitTestStatus(this.prevStatus, next);
    for (const r of diff.newlyCompleted) {
      this.callbacks.onExerciseCompleted?.(r);
    }
    this.prevStatus = next;

    if (next.status !== 'IDLE') {
      this.hasSeenNonIdle = true;
    }

    // Terminal conditions: device says DONE, or it returned to IDLE
    // after we saw a non-IDLE phase (configurable).
    const idleTerminal =
      this.opts.treatIdleAsDone &&
      next.status === 'IDLE' &&
      this.hasSeenNonIdle;
    if (next.done || idleTerminal) {
      this.finishRun(next);
      return;
    }

    // If we're in aborting mode, also stop polling after the deadline.
    if (this._state === 'aborting' && Date.now() >= this.postAbortDeadline) {
      this.finishRun(next);
    }
  }

  private finishRun(last: FitTestStatus): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Build the result.
    const exerciseResults: ExerciseResult[] = last.exercises
      .filter((e) => e.status === 'PASS' || e.status === 'FAIL' || e.status === 'EXCLUDED')
      .map((e) => ({
        index: e.index,
        name: e.name,
        fitFactor: e.fitFactor,
        status: e.status as 'PASS' | 'FAIL' | 'EXCLUDED',
      }));
    const result: FitTestResult = {
      ffOverall: last.ffOverall,
      ffOverallStatus: last.ffOverallStatus,
      exercises: exerciseResults,
      error: last.error,
      lastStatus: last,
    };

    if (this.finalizeError) {
      // Abort path — caller asked us to stop, so reject even though we
      // captured a snapshot.
      this._state = 'failed';
      this.callbacks.onError?.(this.finalizeError);
      this.rejectRun?.(new FitTestAbortedError(this.finalizeError));
    } else if (last.error) {
      this._state = 'failed';
      const reason: FitTestAbortReason = { kind: 'device-error', detail: last.error };
      this.callbacks.onError?.(reason);
      this.rejectRun?.(new FitTestAbortedError(reason));
    } else {
      this._state = 'completed';
      this.callbacks.onOverallResult?.(last.ffOverall, last.ffOverallStatus);
      this.resolveRun?.(result);
    }
    this.resolveRun = null;
    this.rejectRun = null;
  }

  private failWith(reason: FitTestAbortReason): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (reason.kind === 'transport-error' && reason.cause instanceof FitTestAbortedSentinel) {
      // The sentinel thrown by bailIfAborted carries the actual reason.
      reason = reason.cause.reason;
    }
    this._state = 'failed';
    this.callbacks.onError?.(reason);
    this.rejectRun?.(new FitTestAbortedError(reason));
    this.resolveRun = null;
    this.rejectRun = null;
  }
}

/** Thrown from `run()` when the runner finalizes with an error reason
 * (device-error, transport-error, user-abort). Exposes the structured
 * {@link FitTestAbortReason} as `reason`. */
export class FitTestAbortedError extends Error {
  readonly reason: FitTestAbortReason;
  constructor(reason: FitTestAbortReason) {
    super(describeReason(reason));
    this.name = 'FitTestAbortedError';
    this.reason = reason;
  }
}

class FitTestAbortedSentinel extends Error {
  readonly reason: FitTestAbortReason;
  constructor(reason: FitTestAbortReason) {
    super(describeReason(reason));
    this.name = 'FitTestAbortedSentinel';
    this.reason = reason;
  }
}

function describeReason(r: FitTestAbortReason): string {
  switch (r.kind) {
    case 'user-abort':
      return 'fit test aborted by user';
    case 'device-error':
      return `fit test failed: ${r.detail}`;
    case 'transport-error':
      return `fit test transport error: ${r.cause.message}`;
  }
}
