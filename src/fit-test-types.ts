/**
 * Public DTOs for the device-driven fit-test flow on the Portacount 8030.
 *
 * The 8030 has its own on-board fit-test engine: the host pushes person,
 * mask, and protocol records into a temporary database, sends FITTEST/START,
 * and then polls FITTEST/ALL until the device reports DONE. This file holds
 * the host-facing types — both the inputs the runner accepts and the
 * snapshot/result types it emits.
 */

/** A single exercise step in a fit-test protocol. */
export interface ProtocolExercise {
  /** Display name, e.g. "Normal Breathing". */
  name: string;
  /** When true, the device runs the exercise but excludes it from the
   * overall fit-factor calculation. */
  excluded: boolean;
  /** Seconds to sample on the mask side for this exercise. */
  maskSampleSec: number;
}

/** A complete protocol definition. The device's slot holds at most 12
 * exercises; longer arrays are an error, shorter ones are padded with
 * empty slots when serialized. */
export interface FitTestProtocolDef {
  name: string;
  /** Written into PROTOCOL/MODEL. Typically the device model string
   * returned by SYSTEM/ALL. */
  model: string;
  n95Enable: boolean;
  ambientPurgeSec: number;
  ambientSampleSec: number;
  maskPurgeSec: number;
  /** PROTOCOL/PERIOD — months between required tests. The device stores
   * this in the protocol record; it is not directly observable in the
   * runtime status. */
  periodSec: number;
  endOnExerciseFail: boolean;
  exercises: ProtocolExercise[];
}

/** Person record. Only first/last/idNumber are required; sensible
 * defaults fill in the rest. */
export interface FitTestPerson {
  lastName: string;
  firstName: string;
  idNumber: string;
  company?: string;
  location?: string;
  note?: string;
}

/** Respirator (mask) record. */
export interface FitTestMask {
  manufacturer?: string;
  model: string;
  /** FFPASSLEVEL — required pass threshold. */
  passLevel: number;
  n95Enable: boolean;
}

/** Per-test start options. These are written into the FITTEST/START
 * command itself, not the protocol record. */
export interface FitTestStartOptions {
  /** Free-form size string (e.g. "M"). Device may enforce its own enum. */
  maskSize: string;
  operator: string;
  /** When true, abort the test if the overall fit factor becomes
   * unachievable mid-run. */
  endOnOverallFFUnachievable: boolean;
}

/** Status of one exercise as the test progresses.
 *
 * `COMPUTING` is host-synthesized: the 8030 sends per-exercise STATUS
 * only as `IDLE` / `PASS` / `FAIL` / `EXCLUDED`. The currently-active
 * exercise stays at `IDLE` (which we promote to `TESTING`), and after
 * its mask sample ends the device leaves it at `IDLE` for one or more
 * polls while it computes the fit factor — during which `EXERCISE_NUMBER`
 * has already advanced. The runner detects that gap and parks the slot
 * at `COMPUTING` until the device commits `PASS` or `FAIL`, so the UI
 * doesn't show two simultaneously-`TESTING` rows. */
export type ExerciseStatus =
  | 'NOT_STARTED'
  | 'TESTING'
  | 'COMPUTING'
  | 'PASS'
  | 'FAIL'
  | 'EXCLUDED';

/** Snapshot of one exercise within a FITTEST/ALL response. */
export interface ExerciseSnapshot {
  /** 0..11. */
  index: number;
  name: string;
  /** `null` when the device sent an empty string (exercise not started yet). */
  fitFactor: number | null;
  status: ExerciseStatus;
  excluded: boolean;
}

/** Strict-typed snapshot of one FITTEST/ALL poll response. Fields that
 * the device may omit are declared optional (the property is absent
 * rather than carrying an empty-string or `null` sentinel). */
export interface FitTestStatus {
  newData: string;
  msgMain?: string;
  ffOverall: number | null;
  ffOverallStatus?: 'PASS' | 'FAIL';
  /** Phase name, or `'IDLE'` before/after the test. Absent if the device
   * omitted STATUS. */
  status?: string;
  done: boolean;
  /** Absent when no error. Documented values:
   * `ERROR_OVERALL_FF_UNACHIEVABLE`, `ERROR_EXERCISE_FAIL`. The device's
   * `UNSET` placeholder is treated as absent (only specific strings are
   * actionable). */
  error?: string;
  progressPercent: number;
  exerciseNumber: number;
  ffPassLevel: number;
  ambConc: number;
  ambConcStatus?: 'PASS' | 'FAIL' | 'TESTING';
  maskConc: number;
  maskConcStatus?: 'PASS' | 'FAIL' | 'TESTING';
  /** Seconds elapsed in the current phase. */
  seconds: number;
  /** Total seconds elapsed in the test so far. */
  totalSeconds: number;
  lowAlcoholWarning: boolean;
  lowParticleWarning: boolean;
  /** Always length 12, indices 0..11. Missing INDEX entries are filled
   * with NOT_STARTED placeholders. */
  exercises: ExerciseSnapshot[];
  /** The raw parsed FITTEST sub-object — kept so the UI can render any
   * tags we haven't documented yet. */
  raw: Record<string, unknown>;
}

/** Final per-exercise record, emitted when the exercise transitions to
 * a terminal status (PASS/FAIL/EXCLUDED). */
export interface ExerciseResult {
  index: number;
  name: string;
  fitFactor: number | null;
  status: Exclude<ExerciseStatus, 'NOT_STARTED' | 'TESTING' | 'COMPUTING'>;
}

/** Returned by {@link FitTestRunner.run} on success. */
export interface FitTestResult {
  /** Discriminator for storage and shared UI code. The 8030 runner
   * always sets `'8030'`; the 8020 runner produces its own
   * `FitTestResult8020` and is normalized into this shape with
   * `deviceModel: '8020'` and the 8030-specific fields left undefined. */
  deviceModel?: '8020' | '8030';
  ffOverall: number | null;
  ffOverallStatus?: 'PASS' | 'FAIL';
  exercises: ExerciseResult[];
  /** Absent on success. */
  error?: string;
  /** The snapshot that produced DONE/IDLE — useful for diagnostics.
   * Absent for 8020 results: the 8020 has no equivalent FITTEST/ALL
   * snapshot. */
  lastStatus?: FitTestStatus;
}

/** Tagged reason for an aborted run. */
export type FitTestAbortReason =
  | { kind: 'user-abort' }
  | { kind: 'device-error'; detail: string }
  | { kind: 'transport-error'; cause: Error };

/** Callback bundle. All callbacks are optional. */
export interface FitTestRunnerCallbacks {
  /** Fired on every successful poll, after parsing. Full snapshot. */
  onStatusUpdate?: (status: FitTestStatus) => void;
  /** Fired on every poll where AMB or MASK is in TESTING state. */
  onSample?: (s: {
    /** Milliseconds since run() was called. */
    t: number;
    amb: number;
    mask: number;
    ambStatus?: 'PASS' | 'FAIL' | 'TESTING';
    maskStatus?: 'PASS' | 'FAIL' | 'TESTING';
    /** 0-based exercise the device says is currently running. */
    exerciseNumber?: number;
    /** Phase string the device emits — e.g. AMBIENT_SAMPLE, MASK_SAMPLE. */
    phase?: string;
  }) => void;
  /** Fired once per exercise when it transitions to a terminal status. */
  onExerciseCompleted?: (result: ExerciseResult) => void;
  /** Fired once at end, just before the run-promise resolves. */
  onOverallResult?: (ffOverall: number | null, status: 'PASS' | 'FAIL' | undefined) => void;
  /** Fired before the run-promise rejects. Use either onError or the
   * promise rejection — both fire. */
  onError?: (reason: FitTestAbortReason) => void;
}

/** Tunables. All optional. */
export interface FitTestRunnerOptions {
  /** Poll cadence in ms. Defaults to 333. */
  pollIntervalMs?: number;
  /** Per-poll timeout in ms (FITTEST/ALL). Defaults to 3000. */
  pollTimeoutMs?: number;
  /** Per-write timeout in ms for priming (STOP, NEW_TEMP_DATABASE,
   * PEOPLE, RESPIRATOR, PROTOCOL) and FITTEST/START. Defaults to 5000. */
  primeTimeoutMs?: number;
  /** When true, send FITTEST/STOP at the start of priming so the device
   * is in a known state before the DB writes. Defaults to true. */
  resetDeviceState?: boolean;
  /** When true, send NEW_TEMP_DATABASE before writing person/mask/protocol.
   * Defaults to true. */
  resetTempDb?: boolean;
  /** When true, treat STATUS=="IDLE" as terminal, but only after we've
   * observed at least one non-IDLE status (guards against the initial
   * IDLE the device may briefly report between START and phase entry).
   * Defaults to true. */
  treatIdleAsDone?: boolean;
  /** How long to keep polling after STOP before giving up on the device
   * flushing a final snapshot. Defaults to 2000 ms. */
  postAbortPollMs?: number;
}

/** Public state of the runner. */
export type FitTestRunnerState =
  | 'idle'
  | 'priming'
  | 'starting'
  | 'polling'
  | 'aborting'
  | 'completed'
  | 'failed';
