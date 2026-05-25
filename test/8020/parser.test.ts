import { describe, expect, it } from 'vitest';
import { parseLine, parseSetting } from '../../src/8020/parser';

describe('parseLine', () => {
  it('returns null on empty / whitespace lines', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
  });

  it('parses bare particle count (external mode)', () => {
    expect(parseLine('006408.45')).toEqual({ kind: 'particle-count', concentration: 6408.45 });
  });

  it('parses internal-mode count reading', () => {
    expect(parseLine('Conc.      0.00 #/cc')).toEqual({
      kind: 'count-reading',
      concentration: 0,
    });
    expect(parseLine('Conc.     10200 #/cc')).toEqual({
      kind: 'count-reading',
      concentration: 10200,
    });
  });

  it('parses NEW TEST PASS', () => {
    expect(parseLine('NEW TEST PASS =  100')).toEqual({ kind: 'new-test-pass', passLevel: 100 });
  });

  it('parses Ambient reading', () => {
    expect(parseLine('Ambient   2290 #/cc')).toEqual({
      kind: 'ambient-reading',
      concentration: 2290,
    });
  });

  it('parses Mask reading', () => {
    expect(parseLine('Mask    5.62 #/cc')).toEqual({ kind: 'mask-reading', concentration: 5.62 });
  });

  it('parses FF exercise result', () => {
    expect(parseLine('FF  1    352 PASS')).toEqual({
      kind: 'exercise-ff',
      exerciseNumber: 1,
      fitFactor: 352,
      result: 'PASS',
    });
  });

  it('parses FF FAIL with stripped trailing whitespace', () => {
    expect(parseLine('FF  4   42 FAIL')).toEqual({
      kind: 'exercise-ff',
      exerciseNumber: 4,
      fitFactor: 42,
      result: 'FAIL',
    });
  });

  it('parses Overall FF', () => {
    expect(parseLine('Overall FF    89 FAIL')).toEqual({
      kind: 'overall-ff',
      fitFactor: 89,
      result: 'FAIL',
    });
  });

  it('parses Test Terminated', () => {
    expect(parseLine('Test Terminated')).toEqual({ kind: 'test-terminated' });
  });

  it('parses Low Particle Count', () => {
    expect(parseLine('970/cc Low Particle Count')).toEqual({
      kind: 'low-particle-count',
      concentration: 970,
    });
  });

  it('parses valve / data-tx acks', () => {
    expect(parseLine('VN')).toEqual({ kind: 'sampling-from-ambient' });
    expect(parseLine('VF')).toEqual({ kind: 'sampling-from-mask' });
    expect(parseLine('ZE')).toEqual({ kind: 'data-tx-enabled' });
    expect(parseLine('ZD')).toEqual({ kind: 'data-tx-disabled' });
  });

  it('parses external-control acks', () => {
    expect(parseLine('OK')).toEqual({ kind: 'external-control', first: true });
    expect(parseLine('EJ')).toEqual({ kind: 'external-control', first: false });
  });

  it('parses internal-control / power-off acks', () => {
    expect(parseLine('G')).toEqual({ kind: 'internal-control' });
    expect(parseLine('Y')).toEqual({ kind: 'power-off' });
  });

  it('parses N95 companion responses', () => {
    expect(parseLine('QY')).toEqual({ kind: 'n95-companion', connected: true });
    expect(parseLine('QN')).toEqual({ kind: 'n95-companion', connected: false });
  });

  it('parses runtime status', () => {
    expect(parseLine('RGG')).toEqual({ kind: 'runtime-status', battery: 'G', pulse: 'G' });
    expect(parseLine('RGB')).toEqual({ kind: 'runtime-status', battery: 'G', pulse: 'B' });
    expect(parseLine('RBB')).toEqual({ kind: 'runtime-status', battery: 'B', pulse: 'B' });
  });

  it('parses component voltages', () => {
    expect(parseLine('CS191')).toEqual({ kind: 'component-voltage', component: 'CS', value: '191' });
    expect(parseLine('CT236')).toEqual({ kind: 'component-voltage', component: 'CT', value: '236' });
  });

  it('parses settings burst', () => {
    expect(parseLine('STPA  00005')).toEqual({
      kind: 'setting',
      setting: { kind: 'ambient-purge', durationSec: 5 },
    });
    expect(parseLine('STM01 00040')).toEqual({
      kind: 'setting',
      setting: { kind: 'mask-sample', exerciseNum: 1, durationSec: 40 },
    });
    expect(parseLine('SP 01  00100')).toEqual({
      kind: 'setting',
      setting: { kind: 'ff-pass-level', index: 1, passLevel: 100 },
    });
    expect(parseLine('SS 17754')).toEqual({
      kind: 'setting',
      setting: { kind: 'serial-number', serialNumber: '17754' },
    });
    expect(parseLine('SR 5432')).toEqual({
      kind: 'setting',
      setting: { kind: 'runtime-tens-of-minutes', runtime: 5432 },
    });
    expect(parseLine('SD 00524')).toEqual({
      kind: 'setting',
      setting: { kind: 'last-service-date', month: 5, year: 24 },
    });
  });

  it('parses error and write-protect prefixes', () => {
    expect(parseLine('EZE')).toEqual({ kind: 'error', command: 'ZE' });
    expect(parseLine('WPTM0140')).toEqual({ kind: 'write-protected', command: 'PTM0140' });
  });

  it('does not confuse single-letter command echoes with error prefix', () => {
    // 'Y' is an echo of the power-off command. The error regex
    // requires at least one byte after 'E', so a bare 'E' wouldn't
    // match — but 'Y' should map to power-off.
    expect(parseLine('Y')).toEqual({ kind: 'power-off' });
    // Bare 'E' has no command suffix; it should be unknown.
    expect(parseLine('E')).toEqual({ kind: 'unknown', line: 'E' });
  });

  it('recognises boot banner title and captures firmware version', () => {
    expect(parseLine('PORTACOUNT PLUS PROM V1.7')).toEqual({
      kind: 'banner-firmware',
      version: 'V1.7',
    });
  });

  it('returns unknown for unparseable lines', () => {
    expect(parseLine('this is gibberish')).toEqual({
      kind: 'unknown',
      line: 'this is gibberish',
    });
  });

  it('disambiguates FF reading from particle count', () => {
    // A bare numeric line is a particle count.
    expect(parseLine('000352.00')).toEqual({ kind: 'particle-count', concentration: 352 });
    // The same number embedded in "FF n value PASS" is an exercise FF.
    expect(parseLine('FF  3    352 PASS')).toEqual({
      kind: 'exercise-ff',
      exerciseNumber: 3,
      fitFactor: 352,
      result: 'PASS',
    });
  });
});

describe('parseSetting', () => {
  it('returns null on non-setting lines', () => {
    expect(parseSetting('Ambient   100')).toBeNull();
    expect(parseSetting('VN')).toBeNull();
  });

  it('parses mask purge and ambient sample', () => {
    expect(parseSetting('STPM  00011')).toEqual({ kind: 'mask-purge', durationSec: 11 });
    expect(parseSetting('STA   00005')).toEqual({ kind: 'ambient-sample', durationSec: 5 });
  });
});
