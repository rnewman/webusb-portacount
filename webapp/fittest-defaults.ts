/**
 * Default fit-test protocols shipped with the webapp. Selected via the
 * fit-test form.
 *
 * The "OSHA quick" protocol is the abbreviated 4-exercise sequence
 * commonly used for ad-hoc testing. The "OSHA full" mirrors the
 * 7-exercise sequence from 29 CFR 1910.134 Appendix A (modified ambient
 * variant — bending replaces deep breathing in some clinical setups,
 * but we go with the canonical sequence here). The "Probe" protocol is
 * a one-exercise check for diagnostics.
 *
 * All timings in seconds.
 */

import type { FitTestProtocolDef } from 'webusb-portacount';

export interface NamedProtocol extends FitTestProtocolDef {
  /** UI label, also used as the protocol's NAME on the device. */
  displayName: string;
}

const SHARED_TIMINGS = {
  ambientPurgeSec: 4,
  ambientSampleSec: 5,
  maskPurgeSec: 11,
  periodSec: 6,
  endOnExerciseFail: false,
};

export const PROBE_PROTOCOL: NamedProtocol = {
  displayName: 'Probe (1 exercise, 30 s)',
  name: 'Probe (1 exercise, 30 s)',
  model: '8030',
  n95Enable: false,
  ...SHARED_TIMINGS,
  exercises: [
    { name: 'Normal Breathing', excluded: false, maskSampleSec: 30 },
  ],
};

export const OSHA_QUICK: NamedProtocol = {
  displayName: 'OSHA quick (4 exercises)',
  name: 'OSHA quick (4 exercises)',
  model: '8030',
  n95Enable: false,
  ...SHARED_TIMINGS,
  exercises: [
    { name: 'Normal Breathing', excluded: false, maskSampleSec: 30 },
    { name: 'Deep Breathing', excluded: false, maskSampleSec: 30 },
    { name: 'Head Side-to-Side', excluded: false, maskSampleSec: 30 },
    { name: 'Head Up and Down', excluded: false, maskSampleSec: 30 },
  ],
};

export const OSHA_FULL: NamedProtocol = {
  displayName: 'OSHA modified ambient (7 exercises)',
  name: 'OSHA modified ambient',
  model: '8030',
  n95Enable: false,
  ...SHARED_TIMINGS,
  exercises: [
    { name: 'Normal Breathing', excluded: false, maskSampleSec: 60 },
    { name: 'Deep Breathing', excluded: false, maskSampleSec: 60 },
    { name: 'Head Side-to-Side', excluded: false, maskSampleSec: 60 },
    { name: 'Head Up and Down', excluded: false, maskSampleSec: 60 },
    { name: 'Talking', excluded: false, maskSampleSec: 60 },
    { name: 'Bending Over', excluded: false, maskSampleSec: 60 },
    { name: 'Normal Breathing (2)', excluded: false, maskSampleSec: 60 },
  ],
};

export const DEFAULT_PROTOCOLS: NamedProtocol[] = [
  PROBE_PROTOCOL,
  OSHA_QUICK,
  OSHA_FULL,
];
