/**
 * Pure line-level parser for the PortaCount 8020 wire protocol.
 *
 * Maps a single inbound line to a {@link ParsedEvent} (discriminated
 * union) or {@link UnknownLine} if no pattern matches. The parser is
 * stateless; ordering of incoming lines, command echo correlation,
 * and accumulation into a coherent device-state snapshot all live in
 * higher layers ({@link command-queue}, {@link state}).
 *
 * Pattern ordering matters: more-specific patterns (e.g. `FF n value`)
 * must precede the less-specific catch-alls (`COUNT_READING`).
 */

import {
  AMBIENT_READING,
  BANNER_AMBIENT_PURGE,
  BANNER_AMBIENT_SAMPLE,
  BANNER_COPYRIGHT,
  BANNER_DIP_SWITCH,
  BANNER_EXERCISE_COUNT,
  BANNER_FF_PASS_LEVEL,
  BANNER_MASK_PURGE,
  BANNER_MASK_SAMPLE,
  BANNER_SERIAL_NUMBER,
  BOOT_BANNER_TITLE,
  COMPONENT_VOLTAGE,
  COUNT_READING,
  DATA_TRANSMISSION_DISABLED,
  DATA_TRANSMISSION_ENABLED,
  ERROR_RESPONSE,
  EXTERNAL_CONTROL,
  FF_READING,
  INTERNAL_CONTROL,
  LOW_PARTICLE_COUNT,
  MASK_READING,
  N95_COMPANION,
  NEW_TEST_PASS,
  OVERALL_FF,
  PARTICLE_COUNT,
  RUNTIME_STATUS,
  SAMPLING_FROM_AMBIENT,
  SAMPLING_FROM_MASK,
  SETTING_AMBIENT_PURGE,
  SETTING_AMBIENT_SAMPLE,
  SETTING_FF_PASS_LEVEL,
  SETTING_LAST_SERVICE_DATE,
  SETTING_MASK_PURGE,
  SETTING_MASK_SAMPLE,
  SETTING_RUNTIME,
  SETTING_SERIAL_NUMBER,
  TEST_TERMINATED,
  TURN_POWER_OFF,
  WRITE_PROTECTED,
} from './patterns';

export type ExerciseResultLabel = 'PASS' | 'FAIL' | string;

export type ParsedEvent =
  | { kind: 'particle-count'; concentration: number }
  | { kind: 'count-reading'; concentration: number }
  | { kind: 'ambient-reading'; concentration: number }
  | { kind: 'mask-reading'; concentration: number }
  | { kind: 'new-test-pass'; passLevel: number }
  | {
      kind: 'exercise-ff';
      exerciseNumber: number;
      fitFactor: number;
      result: ExerciseResultLabel;
    }
  | { kind: 'overall-ff'; fitFactor: number; result: ExerciseResultLabel }
  | { kind: 'test-terminated' }
  | { kind: 'low-particle-count'; concentration: number }
  | { kind: 'sampling-from-ambient' }
  | { kind: 'sampling-from-mask' }
  | { kind: 'data-tx-enabled' }
  | { kind: 'data-tx-disabled' }
  | { kind: 'external-control'; first: boolean }
  | { kind: 'internal-control' }
  | { kind: 'power-off' }
  | { kind: 'n95-companion'; connected: boolean }
  | { kind: 'runtime-status'; battery: StatusFlag; pulse: StatusFlag }
  | { kind: 'component-voltage'; component: string; value: string }
  | { kind: 'setting'; setting: ParsedSetting }
  | { kind: 'banner-firmware'; version: string }
  | { kind: 'banner-copyright'; year: number }
  | { kind: 'banner-serial-number'; serialNumber: string }
  | { kind: 'banner-ff-pass-level'; passLevel: number }
  | { kind: 'banner-exercise-count'; count: number }
  | { kind: 'banner-ambient-purge'; durationSec: number }
  | { kind: 'banner-ambient-sample'; durationSec: number }
  | { kind: 'banner-mask-purge'; durationSec: number }
  | { kind: 'banner-mask-sample'; exerciseNum: number; durationSec: number }
  | { kind: 'banner-dip-switch'; switches: string }
  | { kind: 'error'; command: string }
  | { kind: 'write-protected'; command: string };

export type StatusFlag = 'G' | 'B' | '?';

export type ParsedSetting =
  | { kind: 'ambient-purge'; durationSec: number }
  | { kind: 'mask-purge'; durationSec: number }
  | { kind: 'ambient-sample'; durationSec: number }
  | { kind: 'mask-sample'; exerciseNum: number; durationSec: number }
  | { kind: 'ff-pass-level'; index: number; passLevel: number }
  | { kind: 'serial-number'; serialNumber: string }
  | { kind: 'runtime-tens-of-minutes'; runtime: number }
  | { kind: 'last-service-date'; month: number; year: number };

export interface UnknownLine {
  kind: 'unknown';
  line: string;
}

/** Parse one line. Returns null if the line is empty or whitespace
 * only; the caller should drop those. Returns an {@link UnknownLine}
 * record when no pattern matches — useful for live debugging panes. */
export function parseLine(line: string): ParsedEvent | UnknownLine | null {
  if (line.length === 0) return null;
  if (/^\s*$/.test(line)) return null;

  // Test progress (internal control mode) — try these *before* the
  // generic count/concentration patterns, since "Ambient 2290" would
  // also match nothing else, and "FF 1 352 PASS" must not be mistaken
  // for a number.
  let m: RegExpMatchArray | null;

  m = OVERALL_FF.exec(line);
  if (m) {
    return {
      kind: 'overall-ff',
      fitFactor: numberOrNaN(m.groups!.fitFactor),
      result: m.groups!.result.trim(),
    };
  }

  m = FF_READING.exec(line);
  if (m) {
    return {
      kind: 'exercise-ff',
      exerciseNumber: parseInt(m.groups!.exerciseNumber, 10),
      fitFactor: numberOrNaN(m.groups!.fitFactor),
      result: m.groups!.result.trim(),
    };
  }

  m = NEW_TEST_PASS.exec(line);
  if (m) return { kind: 'new-test-pass', passLevel: parseInt(m.groups!.passLevel, 10) };

  m = AMBIENT_READING.exec(line);
  if (m) return { kind: 'ambient-reading', concentration: numberOrNaN(m.groups!.concentration) };

  m = MASK_READING.exec(line);
  if (m) return { kind: 'mask-reading', concentration: numberOrNaN(m.groups!.concentration) };

  if (TEST_TERMINATED.test(line)) return { kind: 'test-terminated' };

  m = LOW_PARTICLE_COUNT.exec(line);
  if (m) {
    return { kind: 'low-particle-count', concentration: numberOrNaN(m.groups!.concentration) };
  }

  // Boot banner lines — emitted only at device power-on. Must come
  // *before* the settings dump because BANNER_MASK_SAMPLE and
  // SETTING_MASK_SAMPLE both look "mask-sample-ish", but the banner
  // form has a `=` and `sec.` literals that the settings form lacks.

  m = BANNER_DIP_SWITCH.exec(line);
  if (m) return { kind: 'banner-dip-switch', switches: m.groups!.switches };

  m = BANNER_MASK_SAMPLE.exec(line);
  if (m) {
    return {
      kind: 'banner-mask-sample',
      exerciseNum: parseInt(m.groups!.exerciseNum, 10),
      durationSec: parseInt(m.groups!.duration, 10),
    };
  }

  m = BANNER_MASK_PURGE.exec(line);
  if (m) return { kind: 'banner-mask-purge', durationSec: parseInt(m.groups!.duration, 10) };

  m = BANNER_AMBIENT_SAMPLE.exec(line);
  if (m) return { kind: 'banner-ambient-sample', durationSec: parseInt(m.groups!.duration, 10) };

  m = BANNER_AMBIENT_PURGE.exec(line);
  if (m) return { kind: 'banner-ambient-purge', durationSec: parseInt(m.groups!.duration, 10) };

  m = BANNER_EXERCISE_COUNT.exec(line);
  if (m) return { kind: 'banner-exercise-count', count: parseInt(m.groups!.count, 10) };

  m = BANNER_FF_PASS_LEVEL.exec(line);
  if (m) return { kind: 'banner-ff-pass-level', passLevel: parseInt(m.groups!.passLevel, 10) };

  m = BANNER_SERIAL_NUMBER.exec(line);
  if (m) return { kind: 'banner-serial-number', serialNumber: m.groups!.serialNumber };

  m = BANNER_COPYRIGHT.exec(line);
  if (m) return { kind: 'banner-copyright', year: parseInt(m.groups!.year, 10) };

  // Settings dump — try before generic boot-banner / unknown.
  const setting = parseSetting(line);
  if (setting) return { kind: 'setting', setting };

  // Status responses.
  m = RUNTIME_STATUS.exec(line);
  if (m) {
    return {
      kind: 'runtime-status',
      battery: asStatusFlag(m.groups!.battery),
      pulse: asStatusFlag(m.groups!.pulse),
    };
  }

  m = COMPONENT_VOLTAGE.exec(line);
  if (m) {
    return { kind: 'component-voltage', component: m.groups!.component, value: m.groups!.value };
  }

  // Command acknowledgments (simple echoes / overrides).
  if (SAMPLING_FROM_AMBIENT.test(line)) return { kind: 'sampling-from-ambient' };
  if (SAMPLING_FROM_MASK.test(line)) return { kind: 'sampling-from-mask' };
  if (DATA_TRANSMISSION_ENABLED.test(line)) return { kind: 'data-tx-enabled' };
  if (DATA_TRANSMISSION_DISABLED.test(line)) return { kind: 'data-tx-disabled' };
  m = EXTERNAL_CONTROL.exec(line);
  if (m) return { kind: 'external-control', first: m[1] === 'OK' };
  if (INTERNAL_CONTROL.test(line)) return { kind: 'internal-control' };
  if (TURN_POWER_OFF.test(line)) return { kind: 'power-off' };

  m = N95_COMPANION.exec(line);
  if (m) return { kind: 'n95-companion', connected: m.groups!.connected.toUpperCase() === 'Y' };

  // Continuous-data fallbacks. COUNT_READING is `Conc. <num>`; the
  // bare-number PARTICLE_COUNT is the external-mode form. These have
  // to come *after* the test-progress lines above, because some of
  // those (e.g. `FF n value`) include numeric tokens that the bare
  // PARTICLE_COUNT regex would otherwise greedily latch onto if its
  // anchors were loosened in the future.
  m = COUNT_READING.exec(line);
  if (m) return { kind: 'count-reading', concentration: numberOrNaN(m.groups!.concentration) };

  m = PARTICLE_COUNT.exec(line);
  if (m) return { kind: 'particle-count', concentration: numberOrNaN(m.groups!.concentration) };

  // Boot banner title — emitted at power-on. Captures the firmware
  // version (e.g. `V1.7`). The interior banner lines are matched
  // earlier in the function.
  m = BOOT_BANNER_TITLE.exec(line);
  if (m) return { kind: 'banner-firmware', version: m.groups!.version };

  // Error and write-protect must come *last* — both prefixes look like
  // an echo of a single-letter command otherwise.
  m = ERROR_RESPONSE.exec(line);
  if (m && m.groups!.command.length > 0) {
    return { kind: 'error', command: m.groups!.command };
  }
  m = WRITE_PROTECTED.exec(line);
  if (m && m.groups!.command.length > 0) {
    return { kind: 'write-protected', command: m.groups!.command };
  }

  return { kind: 'unknown', line };
}

/** Parse a settings-dump record. Returns null if the line is not a
 * recognized setting. Public so tests and tooling can target it
 * without going through {@link parseLine}. */
export function parseSetting(line: string): ParsedSetting | null {
  let m: RegExpMatchArray | null;

  m = SETTING_AMBIENT_PURGE.exec(line);
  if (m) return { kind: 'ambient-purge', durationSec: parseInt(m.groups!.duration, 10) };

  m = SETTING_MASK_PURGE.exec(line);
  if (m) return { kind: 'mask-purge', durationSec: parseInt(m.groups!.duration, 10) };

  m = SETTING_AMBIENT_SAMPLE.exec(line);
  if (m) return { kind: 'ambient-sample', durationSec: parseInt(m.groups!.duration, 10) };

  m = SETTING_MASK_SAMPLE.exec(line);
  if (m) {
    return {
      kind: 'mask-sample',
      exerciseNum: parseInt(m.groups!.exerciseNum, 10),
      durationSec: parseInt(m.groups!.duration, 10),
    };
  }

  m = SETTING_FF_PASS_LEVEL.exec(line);
  if (m) {
    return {
      kind: 'ff-pass-level',
      index: parseInt(m.groups!.index, 10),
      passLevel: parseInt(m.groups!.score, 10),
    };
  }

  m = SETTING_SERIAL_NUMBER.exec(line);
  if (m) return { kind: 'serial-number', serialNumber: m.groups!.serialNumber };

  m = SETTING_RUNTIME.exec(line);
  if (m) return { kind: 'runtime-tens-of-minutes', runtime: parseInt(m.groups!.runtime, 10) };

  m = SETTING_LAST_SERVICE_DATE.exec(line);
  if (m) {
    return {
      kind: 'last-service-date',
      month: parseInt(m.groups!.month, 10),
      year: parseInt(m.groups!.year, 10),
    };
  }

  return null;
}

function numberOrNaN(s: string): number {
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

function asStatusFlag(s: string): StatusFlag {
  return s === 'G' || s === 'B' ? s : '?';
}
