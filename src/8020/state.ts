/**
 * Immutable PortaCount 8020 state with a pure reducer.
 *
 * The reducer maps `(state, ParsedEvent) → state` without side
 * effects. The client wraps it so each inbound line can update state
 * and the new snapshot can be diffed against the prior to fire
 * subscribers.
 *
 * Only state that is observably reflected on the wire belongs here.
 * Connection-state (idle/connecting/ready/closing) is owned by the
 * client, not the reducer.
 */

import type { ParsedEvent, ParsedSetting, StatusFlag } from './parser';

/** Whether the device is currently under host (external) control or
 * driving its own fit-test logic. `unknown` is the startup default,
 * before any J/G/OK/EJ has been observed. */
export type ControlSource = 'unknown' | 'external' | 'internal';

/** Which side the sampling valve is currently pointed at. `unknown`
 * is the startup default, before any VN/VF has been observed. */
export type SampleSource = 'unknown' | 'ambient' | 'mask';

/** Continuous data transmission gate. `unknown` is the startup default. */
export type DataTxState = 'unknown' | 'enabled' | 'disabled';

/** Per-exercise fit factor and pass/fail tag accumulated during an
 * internal-mode fit test. `result` is the raw label the device
 * emitted (`PASS` / `FAIL` / other). */
export interface ExerciseRecord8020 {
  exerciseNumber: number;
  fitFactor: number;
  result: string;
}

/** Snapshot of an in-progress (or completed) fit test, accumulated
 * from `NEW TEST PASS = N`, `FF n value`, and `Overall FF`. */
export interface FitTestProgress8020 {
  passLevel: number | null;
  exercises: ExerciseRecord8020[];
  overallFf: number | null;
  overallResult: string | null;
  /** Set to `'terminated'` if the device emitted `Test Terminated`;
   * `'complete'` if `Overall FF` arrived. */
  terminalReason: 'terminated' | 'complete' | null;
  /** Wall-clock ms (Date.now()) when NEW TEST PASS was observed.
   * Null until then. */
  startedAt: number | null;
}

/** Parsed device settings, accumulated from the `S` response burst. */
export interface DeviceSettings8020 {
  serialNumber: string | null;
  runtimeTensOfMinutes: number | null;
  lastServiceMonth: number | null;
  lastServiceYear: number | null;
  ambientPurgeSec: number | null;
  maskPurgeSec: number | null;
  ambientSampleSec: number | null;
  /** Index 0 unused; entries 1..12 carry per-exercise mask sample sec. */
  maskSampleSec: Record<number, number>;
  /** Index 0 unused; entries 1..12 carry per-exercise FF pass level. */
  ffPassLevel: Record<number, number>;
}

/** Device-status flags reported by the `R` command. */
export interface RuntimeStatus8020 {
  battery: StatusFlag;
  pulse: StatusFlag;
}

export interface Portacount8020State {
  controlSource: ControlSource;
  sampleSource: SampleSource;
  dataTx: DataTxState;
  /** Latest concentration observed on the unsolicited channel — from
   * the bare-number `PARTICLE_COUNT` (external mode) or `Conc.`
   * (internal mode). null until first reading. */
  lastConcentration: number | null;
  /** Most recent `Ambient n #/cc` reading from internal-mode test
   * progress. Reset to null on `NEW TEST PASS`. */
  lastAmbient: number | null;
  /** Most recent `Mask n #/cc` reading from internal-mode test
   * progress. Reset to null on `NEW TEST PASS`. */
  lastMask: number | null;
  /** Boolean flag flipped on by `LOW PARTICLE COUNT`; client/UI can
   * clear it explicitly. */
  lowParticleWarning: boolean;
  /** N95 companion attached, as last reported by `Q`. */
  n95Companion: boolean | null;
  runtime: RuntimeStatus8020 | null;
  settings: DeviceSettings8020;
  /** In-progress or last-completed fit test. null before NEW TEST PASS. */
  fitTest: FitTestProgress8020 | null;
}

export function emptyState(): Portacount8020State {
  return {
    controlSource: 'unknown',
    sampleSource: 'unknown',
    dataTx: 'unknown',
    lastConcentration: null,
    lastAmbient: null,
    lastMask: null,
    lowParticleWarning: false,
    n95Companion: null,
    runtime: null,
    settings: emptySettings(),
    fitTest: null,
  };
}

export function emptySettings(): DeviceSettings8020 {
  return {
    serialNumber: null,
    runtimeTensOfMinutes: null,
    lastServiceMonth: null,
    lastServiceYear: null,
    ambientPurgeSec: null,
    maskPurgeSec: null,
    ambientSampleSec: null,
    maskSampleSec: {},
    ffPassLevel: {},
  };
}

/** Pure reducer. Returns the same reference if the event does not
 * change state (so subscribers can use referential equality). */
export function reduce(
  state: Portacount8020State,
  event: ParsedEvent,
): Portacount8020State {
  switch (event.kind) {
    case 'particle-count':
    case 'count-reading':
      return { ...state, lastConcentration: event.concentration };

    case 'ambient-reading':
      return { ...state, lastAmbient: event.concentration };

    case 'mask-reading':
      return { ...state, lastMask: event.concentration };

    case 'low-particle-count':
      return { ...state, lowParticleWarning: true, lastConcentration: event.concentration };

    case 'sampling-from-ambient':
      return { ...state, sampleSource: 'ambient' };

    case 'sampling-from-mask':
      return { ...state, sampleSource: 'mask' };

    case 'data-tx-enabled':
      return { ...state, dataTx: 'enabled' };

    case 'data-tx-disabled':
      return { ...state, dataTx: 'disabled' };

    case 'external-control':
      return { ...state, controlSource: 'external' };

    case 'internal-control':
      return { ...state, controlSource: 'internal' };

    case 'n95-companion':
      return { ...state, n95Companion: event.connected };

    case 'runtime-status':
      return { ...state, runtime: { battery: event.battery, pulse: event.pulse } };

    case 'new-test-pass':
      return {
        ...state,
        lastAmbient: null,
        lastMask: null,
        fitTest: {
          passLevel: event.passLevel,
          exercises: [],
          overallFf: null,
          overallResult: null,
          terminalReason: null,
          startedAt: Date.now(),
        },
      };

    case 'exercise-ff': {
      const cur =
        state.fitTest ??
        ({
          passLevel: null,
          exercises: [],
          overallFf: null,
          overallResult: null,
          terminalReason: null,
          startedAt: Date.now(),
        } satisfies FitTestProgress8020);
      return {
        ...state,
        fitTest: {
          ...cur,
          exercises: [
            ...cur.exercises,
            {
              exerciseNumber: event.exerciseNumber,
              fitFactor: event.fitFactor,
              result: event.result,
            },
          ],
        },
      };
    }

    case 'overall-ff': {
      const cur =
        state.fitTest ??
        ({
          passLevel: null,
          exercises: [],
          overallFf: null,
          overallResult: null,
          terminalReason: null,
          startedAt: null,
        } satisfies FitTestProgress8020);
      return {
        ...state,
        fitTest: {
          ...cur,
          overallFf: event.fitFactor,
          overallResult: event.result,
          terminalReason: 'complete',
        },
      };
    }

    case 'test-terminated': {
      if (!state.fitTest) {
        return {
          ...state,
          fitTest: {
            passLevel: null,
            exercises: [],
            overallFf: null,
            overallResult: null,
            terminalReason: 'terminated',
            startedAt: null,
          },
        };
      }
      return {
        ...state,
        fitTest: { ...state.fitTest, terminalReason: 'terminated' },
      };
    }

    case 'setting':
      return { ...state, settings: reduceSetting(state.settings, event.setting) };

    case 'component-voltage':
    case 'power-off':
    case 'error':
    case 'write-protected':
    case 'banner-firmware':
    case 'banner-copyright':
    case 'banner-serial-number':
    case 'banner-ff-pass-level':
    case 'banner-exercise-count':
    case 'banner-ambient-purge':
    case 'banner-ambient-sample':
    case 'banner-mask-purge':
    case 'banner-mask-sample':
    case 'banner-dip-switch':
      return state; // no observable state change (banner is owned by BootBannerCollector)

    default: {
      const exhaustive: never = event;
      void exhaustive;
      return state;
    }
  }
}

function reduceSetting(
  s: DeviceSettings8020,
  setting: ParsedSetting,
): DeviceSettings8020 {
  switch (setting.kind) {
    case 'serial-number':
      return { ...s, serialNumber: setting.serialNumber };
    case 'runtime-tens-of-minutes':
      return { ...s, runtimeTensOfMinutes: setting.runtime };
    case 'last-service-date':
      return { ...s, lastServiceMonth: setting.month, lastServiceYear: setting.year };
    case 'ambient-purge':
      return { ...s, ambientPurgeSec: setting.durationSec };
    case 'mask-purge':
      return { ...s, maskPurgeSec: setting.durationSec };
    case 'ambient-sample':
      return { ...s, ambientSampleSec: setting.durationSec };
    case 'mask-sample':
      return {
        ...s,
        maskSampleSec: { ...s.maskSampleSec, [setting.exerciseNum]: setting.durationSec },
      };
    case 'ff-pass-level':
      return {
        ...s,
        ffPassLevel: { ...s.ffPassLevel, [setting.index]: setting.passLevel },
      };
    default: {
      const exhaustive: never = setting;
      void exhaustive;
      return s;
    }
  }
}
