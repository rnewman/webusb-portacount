/**
 * PortaCount 8020 wire-protocol vocabulary.
 *
 * Pure data: command-name constants and a regex table for parsing
 * device output. Sourced from the TSI Technical Addendum and
 * cross-referenced against `adapter/wire-protocol.md`. Treat the
 * regexes as protocol facts rather than implementation choices —
 * they encode what the device emits, not how we choose to consume it.
 *
 * All matches use a single regex per line. The parser tries them in
 * priority order and returns the first match.
 */

/** Commands the host sends to the device. Each is sent verbatim with
 * a trailing `\r`. The device echoes most of them as acknowledgment;
 * exceptions are handled by {@link COMMAND_ACK_OVERRIDES}. */
export const Cmd8020 = Object.freeze({
  /** Invoke external control mode. Device replies `OK` first time,
   * `EJ` if already external. */
  invokeExternal: 'J',
  /** Release external control. Device replies `G`. */
  releaseExternal: 'G',
  /** Power off. Device replies `Y` then powers down. */
  powerOff: 'Y',
  /** Enable continuous data transmission. */
  dataTxEnable: 'ZE',
  /** Disable continuous data transmission. */
  dataTxDisable: 'ZD',
  /** Valve → ambient. */
  valveAmbient: 'VN',
  /** Valve → mask. */
  valveMask: 'VF',
  /** Request runtime status. Reply matches `R<battery><pulse>`. */
  runtimeStatus: 'R',
  /** Request component voltages. Reply is a multi-line burst of
   * `C?nnn` records. */
  voltages: 'C',
  /** Request all settings. Reply is a multi-line burst of `S…` lines. */
  settings: 'S',
  /** Probe for an N95 companion. Reply is `QY` or `QN`. */
  n95Probe: 'Q',
  /** Beep `xx` tenths of a second. PortaCount Plus only. */
  beep: (tenths: number) => `B${pad2(tenths)}`,
} as const);

/** Commands whose ack pattern is *not* the echo of the command itself.
 * Keyed by the command string sent. Value is a regex that the next
 * inbound line must match to satisfy the command.
 *
 * Multi-line bursts (`C`, `S`) do not have a clean ack line —
 * settings/voltage records simply stream until the device falls
 * silent. The client orchestrates those by collecting matching
 * settings lines on the unsolicited channel and waiting for
 * quiescence, not by routing them through the command queue's
 * single-line ack mechanism. */
export const COMMAND_ACK_OVERRIDES: Record<string, RegExp> = {
  J: /^(OK|EJ)$/,
  R: /^R[GB][GB]$/,
  Q: /^Q[YN]$/i,
};

// ---- response regex table ----

/** Device echo of a "switched to ambient" valve command. */
export const SAMPLING_FROM_AMBIENT = /^VN$/;
/** Device echo of a "switched to mask" valve command. */
export const SAMPLING_FROM_MASK = /^VF$/;
export const DATA_TRANSMISSION_ENABLED = /^ZE$/;
export const DATA_TRANSMISSION_DISABLED = /^ZD$/;
/** First `J` returns `OK`, subsequent `J` (while already external) returns `EJ`. */
export const EXTERNAL_CONTROL = /^(OK|EJ)$/;
export const INTERNAL_CONTROL = /^G$/;
export const TURN_POWER_OFF = /^Y$/;
export const N95_COMPANION = /^Q(?<connected>[YN])/i;

/** Continuous-data line in external-control mode: zero-padded
 * concentration per second. */
export const PARTICLE_COUNT = /^\s*(?<concentration>\d+\.\d+)\s*$/;

/** Continuous-data line in internal-control mode (`Conc.   0.00 #/cc`). */
export const COUNT_READING = /^\s*Conc\.\s+(?<concentration>[\d.]+)/i;

// ---- internal-mode test progress ----

export const NEW_TEST_PASS = /^NEW\s+TEST\s+PASS\s*=\s*(?<passLevel>\d+)/i;
export const AMBIENT_READING = /^Ambient\s+(?<concentration>[\d.]+)/i;
export const MASK_READING = /^Mask\s+(?<concentration>[\d.]+)/i;
export const FF_READING =
  /^FF\s+(?<exerciseNumber>\d+)\s+(?<fitFactor>[\d.]+)\s+(?<result>.+)$/;
export const OVERALL_FF = /^Overall\s+FF\s+(?<fitFactor>[\d.]+)\s+(?<result>.+)$/i;
export const TEST_TERMINATED = /^Test\s+Terminated/i;
export const LOW_PARTICLE_COUNT = /^(?<concentration>\d+)\/cc\s+Low\s+Particle\s+Count/i;

// ---- status / introspection ----

/** `RGG`, `RGB`, etc. — battery & pulse flags. */
export const RUNTIME_STATUS = /^R(?<battery>.)(?<pulse>.)$/;
/** Component voltage record (`CS191`, `CB483`, `CT236`, …). */
export const COMPONENT_VOLTAGE = /^(?<component>C[SBTCLPD])(?<value>.+)$/;

// ---- settings dump (response to `S`) ----

export const SETTING_AMBIENT_PURGE = /^STPA\s+(?<duration>\d+)/i;
export const SETTING_MASK_PURGE = /^STPM\s+(?<duration>\d+)/i;
export const SETTING_AMBIENT_SAMPLE = /^STA\s+(?<duration>\d+)/i;
export const SETTING_MASK_SAMPLE = /^STM(?<exerciseNum>\d\d)\s*(?<duration>\d+)/i;
export const SETTING_FF_PASS_LEVEL = /^SP\s+(?<index>\d\d)\s*(?<score>\d+)/i;
export const SETTING_SERIAL_NUMBER = /^SS\s+(?<serialNumber>\d+)/i;
/** 10-minute units. */
export const SETTING_RUNTIME = /^SR\s+(?<runtime>\d+)/i;
export const SETTING_LAST_SERVICE_DATE = /^SD\s+0(?<month>\d\d)(?<year>\d\d)/i;

// ---- error / write-protect prefixes ----

/** Error: command was rejected. The offending command follows the `E`. */
export const ERROR_RESPONSE = /^E(?<command>.+)$/;
/** Write-protected: DIP switch 4 prevents the write. */
export const WRITE_PROTECTED = /^W(?<command>.+)$/;

// ---- boot banner ----

/** Title line from the boot banner (only emitted at power-on).
 * Captures the PROM/firmware version, e.g. `V1.7`. */
export const BOOT_BANNER_TITLE =
  /^PORTACOUNT\s+PLUS\s+PROM\s+(?<version>V?[\d.]+)/i;

/** Copyright line — used as a side-channel for the device firmware year. */
export const BANNER_COPYRIGHT = /^COPYRIGHT\(c\)\s*(?<year>\d{4})/i;

/** Banner serial-number line. Distinct from the settings dump's `SS`
 * record — same value, different format. */
export const BANNER_SERIAL_NUMBER = /^Serial\s+Number\s+(?<serialNumber>\d+)/i;

export const BANNER_FF_PASS_LEVEL = /^FF\s+pass\s+level\s*=\s*(?<passLevel>\d+)/i;
export const BANNER_EXERCISE_COUNT = /^No\.\s+of\s+exers\s*=\s*(?<count>\d+)/i;
export const BANNER_AMBIENT_PURGE = /^Ambt\s+purge\s*=\s*(?<duration>\d+)\s*sec/i;
export const BANNER_AMBIENT_SAMPLE = /^Ambt\s+sample\s*=\s*(?<duration>\d+)\s*sec/i;
export const BANNER_MASK_PURGE = /^Mask\s+purge\s*=\s*(?<duration>\d+)\s*sec/i;
export const BANNER_MASK_SAMPLE =
  /^Mask\s+sample\s+(?<exerciseNum>\d+)\s*=\s*(?<duration>\d+)\s*sec/i;
/** Terminator line of the banner. Eight 0/1 chars covering DIP switches 1..8. */
export const BANNER_DIP_SWITCH = /^DIP\s+switch\s*=\s*(?<switches>[01]+)/i;

// ---- helpers ----

function pad2(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99) {
    throw new RangeError(`pad2: expected 0..99, got ${n}`);
  }
  return n.toString().padStart(2, '0');
}
