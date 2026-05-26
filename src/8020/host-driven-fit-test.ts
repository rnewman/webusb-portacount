/**
 * Host-driven fit test for the PortaCount 8020.
 *
 * The 8020 has no "start test" command, and under external control
 * (`J`) the device's buttons are locked out. So a remote test must
 * be **orchestrated entirely by the host**: switch the valve to
 * ambient, wait, collect particle counts, switch to mask, wait,
 * collect particle counts, compute FF = mean(amb)/mean(mask).
 *
 * This module implements that orchestration against any
 * {@link Portacount8020} instance — real serial, WebSocket
 * simulator, or future BLE adapter. The byte-stream layer is
 * abstracted by {@link Portacount8020} itself, so this code is
 * transport-agnostic.
 *
 * Verified end-to-end against firmware V2.5 with a real 3M
 * half-mask APR + alcohol nebulizer (FF ≈ 185 on 2026-05-25).
 */

import type { Portacount8020 } from './client';
import type {
  ExerciseResult8020,
  FitTestResult8020,
} from './fit-test-runner';

/** Default cycle timings (seconds), shared across all exercises in
 * a host-driven test. Matches the configured timings on a
 * factory-default 8020 (verified from the `S` burst on S/N 44960):
 * 4 s ambient purge, 5 s ambient sample, 11 s mask purge. Mask-sample
 * duration is per-exercise and lives on the {@link HostDrivenExercise}
 * record, not here. */
export const DEFAULT_CYCLE = Object.freeze({
  ambientPurgeSec: 4,
  ambientSampleSec: 5,
  maskPurgeSec: 11,
});

/** Default mask-sample duration when callers want a uniform exercise. */
export const DEFAULT_MASK_SAMPLE_SEC = 40;

/** One exercise's spec — name + mask-sample duration. Mirrors the
 * `ProtocolExercise` shape from `fit-test-types` but kept local so
 * this module doesn't depend on the broader fit-test type tree. */
export interface HostDrivenExercise {
  name: string;
  maskSampleSec: number;
  /** When true, the exercise still runs but its FF is excluded from
   * the overall harmonic mean. Defaults to false. */
  excluded?: boolean;
}

export interface HostDrivenFitTestOptions {
  /** Per-exercise sequence. Each exercise reuses the shared ambient
   * purge/sample and mask purge timings, but its own maskSampleSec. */
  exercises: HostDrivenExercise[];
  ambientPurgeSec: number;
  ambientSampleSec: number;
  maskPurgeSec: number;
  /** OSHA pass threshold for PASS/FAIL labeling. Defaults to 100. */
  passLevel: number;
  /** Per-valve-switch command timeout. Defaults to 4 s. */
  commandTimeoutMs?: number;
  /** Abort the test mid-flight. Resolves rejection with `AbortError`;
   * the test result up to abort time is *not* returned. */
  signal?: AbortSignal;
}

export type FitTestPhase8020 =
  | 'ambient-purge'
  | 'ambient-sample'
  | 'mask-purge'
  | 'mask-sample';

export interface FitTestPhaseInfo {
  exerciseNumber: number;
  phase: FitTestPhase8020;
  /** Total milliseconds this phase will run. */
  durationMs: number;
  /** Whether this phase is collecting samples (vs discarding). */
  collecting: boolean;
}

export interface FitTestSample {
  exerciseNumber: number;
  phase: FitTestPhase8020;
  /** Concentration reading from the device, #/cc. */
  concentration: number;
  /** Milliseconds since the *current phase* started — useful for
   * plotting a per-phase strip chart. */
  tInPhase: number;
}

export interface HostDrivenFitTestCallbacks {
  /** Fired immediately before a phase begins. */
  onPhaseStart?: (info: FitTestPhaseInfo) => void;
  /** Fired immediately after a phase ends, with the collected
   * samples (empty for purge phases). */
  onPhaseEnd?: (info: FitTestPhaseInfo, samples: number[]) => void;
  /** Fired on every particle-count event, regardless of whether the
   * current phase is collecting. Useful for live status display. */
  onSample?: (sample: FitTestSample) => void;
  /** Fired once per exercise, after the FF is computed. */
  onExerciseCompleted?: (result: ExerciseResult8020) => void;
}

export class FitTestAbortedError8020 extends Error {
  constructor(cause?: unknown) {
    super(`fit test aborted${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'FitTestAbortedError8020';
  }
}

/**
 * Drive a full host-orchestrated fit test against a connected
 * {@link Portacount8020}. The client must already be in `ready`
 * state with external control invoked; this function does not call
 * `J` or `ZE` (the caller is responsible for that — typically via
 * `Portacount8020.connect({ enableExternalControl: true, ... })`).
 *
 * Resolves to a {@link FitTestResult8020} on completion. Rejects
 * with {@link FitTestAbortedError8020} if `signal` aborts, or with the
 * underlying error if a valve command fails.
 */
export async function runHostDrivenFitTest(
  client: Portacount8020,
  opts: HostDrivenFitTestOptions,
  callbacks: HostDrivenFitTestCallbacks = {},
): Promise<FitTestResult8020> {
  const { signal } = opts;
  const commandTimeoutMs = opts.commandTimeoutMs ?? 4000;
  const startedAt = Date.now();

  if (signal?.aborted) throw new FitTestAbortedError8020(signal.reason);

  // Subscribe to particle-count events. The active bucket is what
  // collects them; null means "discard". This is set by the phase
  // loop below.
  let activeBucket: number[] | null = null;
  let activeExercise = 0;
  let activePhase: FitTestPhase8020 = 'ambient-purge';
  let phaseStart = 0;

  const unsubscribe = client.onEvent((event) => {
    if (event.kind !== 'particle-count') return;
    callbacks.onSample?.({
      exerciseNumber: activeExercise,
      phase: activePhase,
      concentration: event.concentration,
      tInPhase: Date.now() - phaseStart,
    });
    if (activeBucket !== null) activeBucket.push(event.concentration);
  });

  /** Sleep `ms` while honoring the abort signal. */
  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new FitTestAbortedError8020(signal!.reason));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });

  /** Run one phase: announce start, set bucket, wait, announce end. */
  const phase = async (
    exerciseNumber: number,
    name: FitTestPhase8020,
    durationMs: number,
    bucket: number[] | null,
  ): Promise<void> => {
    activeExercise = exerciseNumber;
    activePhase = name;
    activeBucket = bucket;
    phaseStart = Date.now();
    const info: FitTestPhaseInfo = {
      exerciseNumber,
      phase: name,
      durationMs,
      collecting: bucket !== null,
    };
    callbacks.onPhaseStart?.(info);
    await wait(durationMs);
    callbacks.onPhaseEnd?.(info, bucket ?? []);
    activeBucket = null;
  };

  try {
    // Preconditions: external control + data transmission must be
    // on, otherwise the device ignores commands / doesn't stream
    // counts. Both are idempotent (J replies `EJ` if already in
    // external; ZE re-acks if already enabled), so just send them.
    await client.command('J', { timeoutMs: commandTimeoutMs });
    await client.command('ZE', { timeoutMs: commandTimeoutMs });
    // Start from a known-good valve position.
    await client.command('VN', { timeoutMs: commandTimeoutMs });

    const exercises: ExerciseResult8020[] = [];
    for (let idx = 0; idx < opts.exercises.length; idx++) {
      const ex = opts.exercises[idx]!;
      const i = idx + 1;
      if (signal?.aborted) throw new FitTestAbortedError8020(signal.reason);

      // Ambient phase.
      await client.command('VN', { timeoutMs: commandTimeoutMs });
      await phase(i, 'ambient-purge', opts.ambientPurgeSec * 1000, null);

      const ambSamples: number[] = [];
      await phase(i, 'ambient-sample', opts.ambientSampleSec * 1000, ambSamples);

      // Mask phase.
      await client.command('VF', { timeoutMs: commandTimeoutMs });
      await phase(i, 'mask-purge', opts.maskPurgeSec * 1000, null);

      const maskSamples: number[] = [];
      await phase(i, 'mask-sample', ex.maskSampleSec * 1000, maskSamples);

      const meanAmb = mean(ambSamples);
      const meanMask = mean(maskSamples);
      const ff = meanMask > 0 ? meanAmb / meanMask : Infinity;
      const exerciseResult: ExerciseResult8020 = {
        exerciseNumber: i,
        fitFactor: ff,
        result: ff >= opts.passLevel ? 'PASS' : 'FAIL',
      };
      exercises.push(exerciseResult);
      callbacks.onExerciseCompleted?.(exerciseResult);
    }

    // Courtesy: return valve to ambient at the end so the next test
    // (or the user's spot checks) starts from a known state.
    await client.command('VN', { timeoutMs: commandTimeoutMs }).catch(() => {
      /* non-fatal: closing-time courtesy */
    });

    // Overall FF uses only non-excluded, finite per-exercise FFs.
    const includedFFs = exercises
      .filter((_, idx) => !opts.exercises[idx]!.excluded)
      .map((e) => e.fitFactor)
      .filter((x) => Number.isFinite(x));
    const overall = includedFFs.length > 0 ? harmonicMean(includedFFs) : null;
    const overallResult =
      overall === null ? null : overall >= opts.passLevel ? 'PASS' : 'FAIL';

    return {
      deviceModel: '8020',
      passLevel: opts.passLevel,
      exercises,
      overallFitFactor: overall,
      overallResult,
      terminalReason: 'complete',
      startedAt,
      endedAt: Date.now(),
    };
  } finally {
    unsubscribe();
  }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function harmonicMean(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const sumRecip = xs.reduce(
    (acc, x) => acc + (x > 0 ? 1 / x : Infinity),
    0,
  );
  return xs.length / sumRecip;
}
