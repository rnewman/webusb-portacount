/**
 * PortaCount 8020 boot banner.
 *
 * The 8020 dumps a multi-line banner at power-on, e.g.:
 *
 *   PORTACOUNT PLUS PROM V1.7
 *   COPYRIGHT(c)1992 TSI INC
 *   ALL RIGHTS RESERVED
 *   Serial Number 17754
 *   FF pass level = 100
 *   No. of exers  = 4
 *   Ambt purge   = 4 sec.
 *   Ambt sample  = 5 sec.
 *   Mask purge  = 11 sec.
 *   Mask sample 1 = 40 sec.
 *   ...
 *   DIP switch  = 10111111
 *
 * The banner has no length prefix and no clean ack — only the DIP
 * switch line serves as a natural terminator. {@link BootBannerCollector}
 * watches parsed events, accumulates banner-* fields into a
 * {@link DeviceIdentity8020}, and emits the completed identity when
 * the DIP-switch line arrives (or when start-on / start-fresh is
 * called explicitly).
 *
 * The banner only appears at power-on. If we connect to a device
 * that's already running, we never see it — identity stays empty,
 * and the UI falls back to whatever the settings burst (`S`) gives
 * us (which is a strict subset of banner data: S/N, runtime, service
 * date, but no firmware version or DIP switches).
 */

import type { ParsedEvent, UnknownLine } from './parser';

export interface DeviceIdentity8020 {
  /** PROM/firmware version, e.g. `V1.7`. */
  firmwareVersion?: string;
  /** Copyright year, e.g. 1992 — a side-channel for firmware vintage. */
  copyrightYear?: number;
  serialNumber?: string;
  /** Default FF pass level the device was programmed with. */
  ffPassLevel?: number;
  /** Configured number of exercises (1..12). */
  exerciseCount?: number;
  ambientPurgeSec?: number;
  ambientSampleSec?: number;
  maskPurgeSec?: number;
  /** Index 1..exerciseCount, seconds per exercise. */
  maskSampleSec: Record<number, number>;
  /** Eight 0/1 chars covering DIP switches 1..8. */
  dipSwitch?: string;
  /** Whether we've observed a DIP-switch terminator since the last
   * power-on. False before the banner completes (or if we never see
   * one, because the device was already running when we connected). */
  complete: boolean;
}

export function emptyIdentity(): DeviceIdentity8020 {
  return {
    maskSampleSec: {},
    complete: false,
  };
}

export type BootBannerListener = (identity: DeviceIdentity8020) => void;

/**
 * Accumulates `banner-*` parsed events into a {@link DeviceIdentity8020}.
 * Fires `onIdentity` with a snapshot on every change (the snapshot is
 * a fresh object — referential equality changes), and again on the
 * DIP-switch terminator with `complete: true`.
 */
export class BootBannerCollector {
  private partial: DeviceIdentity8020 = emptyIdentity();

  /** Subscribers fire on every banner-* event that updates the
   * identity, AND on the DIP-switch terminator (which also sets
   * `complete: true`). */
  private listeners = new Set<BootBannerListener>();

  /** Current accumulated identity. Fresh object reference each time
   * a banner field updates. */
  get identity(): DeviceIdentity8020 {
    return this.partial;
  }

  /** Subscribe to identity updates. Returns an unsubscribe function. */
  subscribe(listener: BootBannerListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Reset to an empty identity. Call this on a fresh connect (the
   * next banner we see — if any — starts from scratch). */
  reset(): void {
    this.partial = emptyIdentity();
  }

  /** Feed one parsed event. Banner events update the partial
   * identity; non-banner events are ignored. */
  push(event: ParsedEvent | UnknownLine): void {
    const next = applyBannerEvent(this.partial, event);
    if (next === this.partial) return;
    this.partial = next;
    for (const listener of this.listeners) {
      try {
        listener(next);
      } catch {
        /* ignore listener errors */
      }
    }
  }
}

/** Apply one parsed event to a partial identity. Returns the same
 * reference if the event is not a banner event or doesn't change
 * the identity. Pure — exposed so tests can drive the accumulator
 * directly without a class instance. */
export function applyBannerEvent(
  cur: DeviceIdentity8020,
  event: ParsedEvent | UnknownLine,
): DeviceIdentity8020 {
  switch (event.kind) {
    case 'banner-firmware':
      // A new banner is starting — reset the accumulator. The 8020
      // emits the title line first; treating it as a reset means
      // power-cycling the device mid-session does the right thing.
      return { ...emptyIdentity(), firmwareVersion: event.version };
    case 'banner-copyright':
      return { ...cur, copyrightYear: event.year };
    case 'banner-serial-number':
      return { ...cur, serialNumber: event.serialNumber };
    case 'banner-ff-pass-level':
      return { ...cur, ffPassLevel: event.passLevel };
    case 'banner-exercise-count':
      return { ...cur, exerciseCount: event.count };
    case 'banner-ambient-purge':
      return { ...cur, ambientPurgeSec: event.durationSec };
    case 'banner-ambient-sample':
      return { ...cur, ambientSampleSec: event.durationSec };
    case 'banner-mask-purge':
      return { ...cur, maskPurgeSec: event.durationSec };
    case 'banner-mask-sample':
      return {
        ...cur,
        maskSampleSec: {
          ...cur.maskSampleSec,
          [event.exerciseNum]: event.durationSec,
        },
      };
    case 'banner-dip-switch':
      return { ...cur, dipSwitch: event.switches, complete: true };
    default:
      return cur;
  }
}
