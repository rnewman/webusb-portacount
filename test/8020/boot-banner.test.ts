import { describe, expect, it } from 'vitest';
import { parseLine } from '../../src/8020/parser';
import {
  BootBannerCollector,
  applyBannerEvent,
  emptyIdentity,
  type DeviceIdentity8020,
} from '../../src/8020/boot-banner';

const CANONICAL_BANNER = [
  'PORTACOUNT PLUS PROM V1.7',
  'COPYRIGHT(c)1992 TSI INC',
  'ALL RIGHTS RESERVED',
  'Serial Number 17754',
  'FF pass level = 100',
  'No. of exers  = 4',
  'Ambt purge   = 4 sec.',
  'Ambt sample  = 5 sec.',
  'Mask purge  = 11 sec.',
  'Mask sample 1 = 40 sec.',
  'Mask sample 2 = 40 sec.',
  'Mask sample 3 = 40 sec.',
  'Mask sample 4 = 40 sec.',
  'DIP switch  = 10111111',
];

describe('parseLine banner events', () => {
  it('parses firmware version from the title line', () => {
    expect(parseLine('PORTACOUNT PLUS PROM V1.7')).toEqual({
      kind: 'banner-firmware',
      version: 'V1.7',
    });
  });

  it('parses copyright year', () => {
    expect(parseLine('COPYRIGHT(c)1992 TSI INC')).toEqual({
      kind: 'banner-copyright',
      year: 1992,
    });
  });

  it('parses banner serial number', () => {
    expect(parseLine('Serial Number 17754')).toEqual({
      kind: 'banner-serial-number',
      serialNumber: '17754',
    });
  });

  it('parses banner FF pass level', () => {
    expect(parseLine('FF pass level = 100')).toEqual({
      kind: 'banner-ff-pass-level',
      passLevel: 100,
    });
  });

  it('parses banner exercise count', () => {
    expect(parseLine('No. of exers  = 4')).toEqual({
      kind: 'banner-exercise-count',
      count: 4,
    });
  });

  it('parses banner ambient purge / sample', () => {
    expect(parseLine('Ambt purge   = 4 sec.')).toEqual({
      kind: 'banner-ambient-purge',
      durationSec: 4,
    });
    expect(parseLine('Ambt sample  = 5 sec.')).toEqual({
      kind: 'banner-ambient-sample',
      durationSec: 5,
    });
  });

  it('parses banner mask purge / sample', () => {
    expect(parseLine('Mask purge  = 11 sec.')).toEqual({
      kind: 'banner-mask-purge',
      durationSec: 11,
    });
    expect(parseLine('Mask sample 1 = 40 sec.')).toEqual({
      kind: 'banner-mask-sample',
      exerciseNum: 1,
      durationSec: 40,
    });
    expect(parseLine('Mask sample 12 = 25 sec.')).toEqual({
      kind: 'banner-mask-sample',
      exerciseNum: 12,
      durationSec: 25,
    });
  });

  it('parses DIP switch line', () => {
    expect(parseLine('DIP switch  = 10111111')).toEqual({
      kind: 'banner-dip-switch',
      switches: '10111111',
    });
  });

  it('banner serial-number does not collide with settings SS', () => {
    // SS<spaces><number> is the settings form; banner is "Serial Number <number>".
    expect(parseLine('SS   17754')).toEqual({
      kind: 'setting',
      setting: { kind: 'serial-number', serialNumber: '17754' },
    });
    expect(parseLine('Serial Number 17754')).toEqual({
      kind: 'banner-serial-number',
      serialNumber: '17754',
    });
  });
});

describe('applyBannerEvent', () => {
  it('returns same reference on a non-banner event', () => {
    const cur = emptyIdentity();
    const next = applyBannerEvent(cur, { kind: 'particle-count', concentration: 100 });
    expect(next).toBe(cur);
  });

  it('resets accumulator on banner-firmware (a fresh boot)', () => {
    const seeded: DeviceIdentity8020 = {
      ...emptyIdentity(),
      serialNumber: 'stale',
      ffPassLevel: 999,
      maskSampleSec: { 1: 99 },
      complete: true,
    };
    const next = applyBannerEvent(seeded, { kind: 'banner-firmware', version: 'V2.0' });
    expect(next.firmwareVersion).toBe('V2.0');
    expect(next.serialNumber).toBeUndefined();
    expect(next.ffPassLevel).toBeUndefined();
    expect(next.maskSampleSec).toEqual({});
    expect(next.complete).toBe(false);
  });

  it('mask-sample updates accumulate per exercise', () => {
    let id = emptyIdentity();
    id = applyBannerEvent(id, { kind: 'banner-mask-sample', exerciseNum: 1, durationSec: 40 });
    id = applyBannerEvent(id, { kind: 'banner-mask-sample', exerciseNum: 2, durationSec: 35 });
    expect(id.maskSampleSec).toEqual({ 1: 40, 2: 35 });
  });

  it('DIP switch sets complete=true', () => {
    const id = applyBannerEvent(emptyIdentity(), {
      kind: 'banner-dip-switch',
      switches: '10111111',
    });
    expect(id.complete).toBe(true);
    expect(id.dipSwitch).toBe('10111111');
  });
});

describe('BootBannerCollector', () => {
  it('assembles a full identity from the canonical banner', () => {
    const c = new BootBannerCollector();
    const snapshots: DeviceIdentity8020[] = [];
    c.subscribe((id) => snapshots.push(id));

    for (const line of CANONICAL_BANNER) {
      const ev = parseLine(line);
      if (ev !== null) c.push(ev);
    }

    const id = c.identity;
    expect(id.firmwareVersion).toBe('V1.7');
    expect(id.copyrightYear).toBe(1992);
    expect(id.serialNumber).toBe('17754');
    expect(id.ffPassLevel).toBe(100);
    expect(id.exerciseCount).toBe(4);
    expect(id.ambientPurgeSec).toBe(4);
    expect(id.ambientSampleSec).toBe(5);
    expect(id.maskPurgeSec).toBe(11);
    expect(id.maskSampleSec).toEqual({ 1: 40, 2: 40, 3: 40, 4: 40 });
    expect(id.dipSwitch).toBe('10111111');
    expect(id.complete).toBe(true);

    // Subscriber fired on every banner line (except ALL RIGHTS RESERVED
    // which the parser drops as `unknown`).
    expect(snapshots.length).toBeGreaterThan(10);
    expect(snapshots[snapshots.length - 1]!.complete).toBe(true);
  });

  it('ignores non-banner events', () => {
    const c = new BootBannerCollector();
    c.push({ kind: 'particle-count', concentration: 100 });
    c.push({ kind: 'count-reading', concentration: 50 });
    c.push({ kind: 'unknown', line: 'random' });
    expect(c.identity).toEqual(emptyIdentity());
  });

  it('resets on a fresh banner (device power-cycled mid-session)', () => {
    const c = new BootBannerCollector();
    c.push({ kind: 'banner-firmware', version: 'V1.7' });
    c.push({ kind: 'banner-serial-number', serialNumber: '17754' });
    c.push({ kind: 'banner-dip-switch', switches: '10111111' });
    expect(c.identity.complete).toBe(true);

    // New banner arrives — accumulator should drop the prior state.
    c.push({ kind: 'banner-firmware', version: 'V2.0' });
    expect(c.identity.firmwareVersion).toBe('V2.0');
    expect(c.identity.serialNumber).toBeUndefined();
    expect(c.identity.dipSwitch).toBeUndefined();
    expect(c.identity.complete).toBe(false);
  });

  it('unsubscribe stops listener notifications', () => {
    const c = new BootBannerCollector();
    let count = 0;
    const off = c.subscribe(() => count++);
    c.push({ kind: 'banner-firmware', version: 'V1.7' });
    expect(count).toBe(1);
    off();
    c.push({ kind: 'banner-serial-number', serialNumber: '17754' });
    expect(count).toBe(1);
  });
});
