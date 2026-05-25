/**
 * Pure helpers for the 8030 fit-test wire protocol.
 *
 * XML builders for the DATABASE writes (person, mask, protocol), the
 * atomic FITTEST/START write, and the poll/stop commands. Plus a parser
 * that turns the raw XML of a FITTEST/ALL response into a strict-typed
 * {@link FitTestStatus}, and a diff helper that detects exercise-completion
 * transitions between successive snapshots.
 *
 * No I/O, no timers — everything here is synchronous and pure so it can
 * be unit-tested without the wire layer.
 *
 * Per-exercise blocks come back wrapped in `<EXERCISE>...</EXERCISE>`
 * elements containing nested `<INDEX>` / `<NAME>` / `<FITFACTOR>` /
 * `<STATUS>` / `<EXCLUDE>` children. We use `preserveOrder` parsing
 * because top-level `<STATUS>` and per-exercise `<STATUS>` share a tag
 * name and we need to keep the two scopes separate.
 */

import { XMLParser } from 'fast-xml-parser';

import type {
  ExerciseResult,
  ExerciseSnapshot,
  ExerciseStatus,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestStartOptions,
  FitTestStatus,
} from './fit-test-types';

const MAX_EXERCISES = 12;

/** Reset the device's temp database. Sent before the per-test writes. */
export function buildNewTempDbXml(): string {
  return '<MAIN><DATABASE><NEW_TEMP_DATABASE/></DATABASE></MAIN>';
}

/** Build the PEOPLE write. PEOPLEID is hard-coded to 1 — the device only
 * ever has one temp-record at a time. */
export function buildPersonXml(p: FitTestPerson): string {
  const last = xmlEscape(p.lastName);
  const first = xmlEscape(p.firstName);
  const id = xmlEscape(p.idNumber);
  const company = xmlEscape(p.company ?? 'Unknown');
  const location = xmlEscape(p.location ?? '');
  const note = xmlEscape(p.note ?? 'No information');
  return [
    '<MAIN><DATABASE><PEOPLE Command="WRITE">',
    '<PEOPLEID>1</PEOPLEID>',
    `<LASTNAME>${last}</LASTNAME>`,
    `<FIRSTNAME>${first}</FIRSTNAME>`,
    `<IDNUMBER>${id}</IDNUMBER>`,
    `<COMPANY>${company}</COMPANY>`,
    `<LOCATION>${location}</LOCATION>`,
    `<PEOPLENOTE>${note}</PEOPLENOTE>`,
    '<CUSTOM1LABEL></CUSTOM1LABEL>',
    '<CUSTOM2LABEL></CUSTOM2LABEL>',
    '<CUSTOM3LABEL></CUSTOM3LABEL>',
    '<CUSTOM4LABEL></CUSTOM4LABEL>',
    '<CUSTOM1DATA></CUSTOM1DATA>',
    '<CUSTOM2DATA></CUSTOM2DATA>',
    '<CUSTOM3DATA></CUSTOM3DATA>',
    '<CUSTOM4DATA></CUSTOM4DATA>',
    '</PEOPLE></DATABASE></MAIN>',
  ].join('');
}

/** Build the RESPIRATOR write. RESPIRATORID is hard-coded to 1. */
export function buildRespiratorXml(m: FitTestMask): string {
  const manuf = xmlEscape(m.manufacturer ?? 'blank');
  const model = xmlEscape(m.model);
  return [
    '<MAIN><DATABASE><RESPIRATOR Command="WRITE">',
    '<RESPIRATORID>1</RESPIRATORID>',
    `<MANUFACTURER>${manuf}</MANUFACTURER>`,
    `<MASKMODEL>${model}</MASKMODEL>`,
    '<MASKSTYLE>Not stored</MASKSTYLE>',
    '<APPROVAL>Not stored</APPROVAL>',
    `<FFPASSLEVEL>${Math.round(m.passLevel)}</FFPASSLEVEL>`,
    '<DESCRIPTION>Not stored</DESCRIPTION>',
    '<AUTODESC>Not Stored</AUTODESC>',
    `<N95ENABLE>${m.n95Enable ? 'True' : 'False'}</N95ENABLE>`,
    '</RESPIRATOR></DATABASE></MAIN>',
  ].join('');
}

/**
 * Build the PROTOCOL write. The device's slot holds exactly 12 exercises;
 * shorter inputs are padded with empty entries (EXCLUDE=true, sample
 * time 0) so the device receives a complete record.
 */
export function buildProtocolXml(p: FitTestProtocolDef, deviceModel: string): string {
  if (p.exercises.length > MAX_EXERCISES) {
    throw new Error(`fit-test protocol: too many exercises (${p.exercises.length}, max ${MAX_EXERCISES})`);
  }
  const parts: string[] = [
    '<MAIN><DATABASE><PROTOCOL Command="WRITE">',
    '<PROTOCOLID>1</PROTOCOLID>',
    `<PROTOCOLNAME>${xmlEscape(p.name)}</PROTOCOLNAME>`,
    `<MODEL>${xmlEscape(deviceModel)}</MODEL>`,
    `<N95ENABLE>${p.n95Enable ? 'True' : 'False'}</N95ENABLE>`,
    `<AMBIENTPURGE>${Math.round(p.ambientPurgeSec)}</AMBIENTPURGE>`,
    `<AMBIENTSAMPLE>${Math.round(p.ambientSampleSec)}</AMBIENTSAMPLE>`,
    `<MASKPURGE>${Math.round(p.maskPurgeSec)}</MASKPURGE>`,
    `<PERIOD>${Math.round(p.periodSec)}</PERIOD>`,
    `<ENDONEXFFFAIL>${p.endOnExerciseFail ? 'True' : 'False'}</ENDONEXFFFAIL>`,
  ];
  for (let i = 0; i < MAX_EXERCISES; i++) {
    const e = p.exercises[i];
    parts.push(`<EXERCISE${i + 1}>${xmlEscape(e?.name ?? '')}</EXERCISE${i + 1}>`);
  }
  for (let i = 0; i < MAX_EXERCISES; i++) {
    const e = p.exercises[i];
    // Pad slots default to excluded so the device doesn't try to run them.
    const excluded = e ? e.excluded : true;
    parts.push(`<EXCLUDE${i + 1}>${excluded ? 'True' : 'False'}</EXCLUDE${i + 1}>`);
  }
  for (let i = 0; i < MAX_EXERCISES; i++) {
    const e = p.exercises[i];
    const sec = e ? Math.round(e.maskSampleSec) : 0;
    parts.push(`<MASKSAMPLE${i + 1}>${sec}</MASKSAMPLE${i + 1}>`);
  }
  parts.push(
    '<CHANGEDATE></CHANGEDATE>',
    '<ROWREVISION></ROWREVISION>',
    '</PROTOCOL></DATABASE></MAIN>',
  );
  return parts.join('');
}

/** Build the atomic FITTEST/START write. */
export function buildStartXml(o: FitTestStartOptions): string {
  return [
    '<MAIN><FITTEST>',
    '<PEOPLEID Command="WRITE">1</PEOPLEID>',
    '<PROTOCOLID Command="WRITE">1</PROTOCOLID>',
    '<RESPIRATORID Command="WRITE">1</RESPIRATORID>',
    `<MASKSIZE Command="WRITE">${xmlEscape(o.maskSize)}</MASKSIZE>`,
    `<OPERATOR Command="WRITE">${xmlEscape(o.operator)}</OPERATOR>`,
    `<OVERALL_FF_UNACHIEVABLE_ENABLE Command="WRITE">${o.endOnOverallFFUnachievable ? 'True' : 'False'}</OVERALL_FF_UNACHIEVABLE_ENABLE>`,
    '<START/>',
    '</FITTEST></MAIN>',
  ].join('');
}

/** Poll the device's fit-test status. */
export function buildPollXml(): string {
  return '<MAIN><FITTEST><ALL/></FITTEST></MAIN>';
}

/** Abort the in-flight test. */
export function buildStopXml(): string {
  return '<MAIN><FITTEST><STOP/></FITTEST></MAIN>';
}

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&apos;',
};

/** Escape `&<>"'` in user-supplied text. */
export function xmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

// ---- parsing ----

// fast-xml-parser with preserveOrder gives us each child element as a
// single-key object in document order, e.g.
//   [{ NEWDATA: [{ '#text': 'true' }] }, { STATUS: [{ '#text': 'IDLE' }] }, ...]
// We use preserveOrder mainly to keep top-level <STATUS> isolated from
// the <STATUS> nested inside each <EXERCISE> wrapper — both tag names
// collide, and the FITTEST-level scan needs to ignore exercise scopes.

interface OrderedNode {
  [tagName: string]: OrderedChild[] | OrderedAttrs;
}
type OrderedChild = OrderedNode | { '#text': string };
interface OrderedAttrs {
  [attr: string]: string;
}

const orderedParser = new XMLParser({
  preserveOrder: true,
  parseTagValue: false,
  trimValues: true,
  ignoreAttributes: true,
});

/**
 * Parse a FITTEST/ALL response from raw XML (the string returned by
 * {@link Portacount.command}) into a strict {@link FitTestStatus}.
 *
 * Tolerates trailing `\r\r` and `\0` bytes.
 */
export function parseFitTestStatus(rawXml: string): FitTestStatus {
  const cleaned = rawXml.replace(/\0+$/g, '').replace(/[\r\n]+$/g, '');
  const tree = orderedParser.parse(cleaned) as OrderedChild[];

  const fittestChildren = findFittestChildren(tree);

  // Initialize 12 NOT_STARTED placeholders. Slots not covered by an
  // <EXERCISE> block (or covered by one with no INDEX) stay as-is.
  const exercises: ExerciseSnapshot[] = [];
  for (let n = 0; n < MAX_EXERCISES; n++) {
    exercises.push({
      index: n,
      name: '',
      fitFactor: null,
      status: 'NOT_STARTED',
      excluded: false,
    });
  }

  // Single pass: every direct child of <FITTEST> is either a top-level
  // scalar or an <EXERCISE> wrapper. Recurse into the latter to extract
  // its INDEX/NAME/FITFACTOR/STATUS/EXCLUDE children.
  const topLevel: Record<string, string> = {};
  for (const c of fittestChildren) {
    const tag = tagNameOf(c);
    if (tag === null) continue;
    if (tag === 'EXERCISE') {
      parseExerciseBlock((c as OrderedNode).EXERCISE as OrderedChild[], exercises);
    } else {
      topLevel[tag] = childText(c);
    }
  }

  const s = (k: string): string => topLevel[k] ?? '';
  const f = (k: string): number => parseFloatOrZero(s(k));
  const fOrNull = (k: string): number | null => {
    const t = s(k);
    if (t === '') return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  };
  const iOf = (k: string): number => parseIntOrZero(s(k));
  const b = (k: string): boolean => parseBool(s(k));

  const status: FitTestStatus = {
    newData: s('NEWDATA'),
    ffOverall: fOrNull('FF_OVERALL'),
    done: b('DONE'),
    progressPercent: iOf('PROGRESS_PERCENT'),
    exerciseNumber: iOf('EXERCISE_NUMBER'),
    ffPassLevel: iOf('FF_PASSLEVEL'),
    ambConc: f('AMB_CONC'),
    maskConc: f('MASK_CONC'),
    seconds: iOf('SECONDS'),
    totalSeconds: iOf('TOTAL_SECONDS'),
    lowAlcoholWarning: b('LOW_ALCOHOL_WARNING'),
    lowParticleWarning: b('LOW_PARTICLE_WARNING'),
    exercises,
    raw: topLevel as Record<string, unknown>,
  };
  // Optional fields — only set when the device actually sent a meaningful
  // value. Absent properties (rather than empty strings or null sentinels)
  // are the not-present convention in the protocol layer.
  const msgMain = topLevel['MSG_MAIN'];
  if (msgMain) status.msgMain = msgMain;
  const ffOverallStatus = normalizeOverallStatus(s('FF_OVERALL_STATUS'));
  if (ffOverallStatus) status.ffOverallStatus = ffOverallStatus;
  const statusTag = topLevel['STATUS'];
  if (statusTag) status.status = statusTag;
  const err = normalizeError(s('ERROR'));
  if (err) status.error = err;
  const ambStat = normalizeConcStatus(s('AMB_CONC_STATUS'));
  if (ambStat) status.ambConcStatus = ambStat;
  const maskStat = normalizeConcStatus(s('MASK_CONC_STATUS'));
  if (maskStat) status.maskConcStatus = maskStat;

  // The device never sends per-exercise STATUS=TESTING. The currently
  // running exercise stays at IDLE (which we collapse to NOT_STARTED)
  // until it transitions directly to PASS/FAIL. Identify it via the
  // top-level phase + EXERCISE_NUMBER and promote it ourselves so the UI
  // can highlight the active row.
  if (!status.done && isActivePhase(status.status)) {
    const cur = status.exerciseNumber;
    if (cur >= 0 && cur < MAX_EXERCISES && exercises[cur].status === 'NOT_STARTED') {
      exercises[cur] = { ...exercises[cur], status: 'TESTING' };
    }
  }
  return status;
}

/** True when the top-level FITTEST/STATUS names a phase the device runs
 *  during an active test (ambient or mask purge/sample). `IDLE` and the
 *  absent case are not active. */
function isActivePhase(s: string | undefined): boolean {
  if (!s) return false;
  return s !== 'IDLE';
}

/**
 * Diff two snapshots. Returns the exercises that newly entered a terminal
 * state, and whether the test as a whole transitioned to DONE.
 */
export function diffFitTestStatus(
  prev: FitTestStatus | null,
  next: FitTestStatus,
): { newlyCompleted: ExerciseResult[]; transitionedToDone: boolean } {
  const newlyCompleted: ExerciseResult[] = [];
  for (let n = 0; n < MAX_EXERCISES; n++) {
    const before = prev ? prev.exercises[n].status : 'NOT_STARTED';
    const after = next.exercises[n].status;
    if (isTerminalExerciseStatus(after) && !isTerminalExerciseStatus(before)) {
      newlyCompleted.push({
        index: next.exercises[n].index,
        name: next.exercises[n].name,
        fitFactor: next.exercises[n].fitFactor,
        status: after,
      });
    }
  }
  const transitionedToDone = !!next.done && !prev?.done;
  return { newlyCompleted, transitionedToDone };
}

// ---- preserveOrder tree walkers ----

function tagNameOf(node: OrderedChild): string | null {
  if ('#text' in node) return null;
  const keys = Object.keys(node);
  if (keys.length !== 1) return null;
  const k = keys[0];
  if (k === ':@') return null; // attribute container we asked to ignore
  return k;
}

function isElementNamed(node: OrderedChild, name: string): boolean {
  return tagNameOf(node) === name;
}

function childText(node: OrderedChild): string {
  if ('#text' in node) return String(node['#text']);
  const tag = tagNameOf(node);
  if (tag === null) return '';
  const children = (node as OrderedNode)[tag];
  if (!Array.isArray(children)) return '';
  for (const c of children) {
    if (typeof c === 'object' && c !== null && '#text' in c) {
      return String((c as { '#text': string })['#text']);
    }
  }
  return '';
}

function findFittestChildren(tree: OrderedChild[]): OrderedChild[] {
  // Top-level should be [{ MAIN: [...] }] or sometimes [{ FITTEST: [...] }]
  // (we accept both for robustness).
  for (const top of tree) {
    if (isElementNamed(top, 'MAIN')) {
      const mainKids = (top as OrderedNode).MAIN as OrderedChild[];
      for (const sub of mainKids) {
        if (isElementNamed(sub, 'FITTEST')) {
          return (sub as OrderedNode).FITTEST as OrderedChild[];
        }
      }
    } else if (isElementNamed(top, 'FITTEST')) {
      return (top as OrderedNode).FITTEST as OrderedChild[];
    }
  }
  return [];
}

// ---- value coercion ----

function parseFloatOrZero(s: string): number {
  if (s === '') return 0;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function parseIntOrZero(s: string): number {
  if (s === '') return 0;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

function parseBool(s: string): boolean {
  return s.toLowerCase() === 'true';
}

function normalizeOverallStatus(s: string): 'PASS' | 'FAIL' | undefined {
  const u = s.toUpperCase();
  return u === 'PASS' || u === 'FAIL' ? u : undefined;
}

/** The device reports `<ERROR>UNSET</ERROR>` as its "no error set"
 * sentinel — only specific values (`ERROR_OVERALL_FF_UNACHIEVABLE`,
 * `ERROR_EXERCISE_FAIL`) are actionable. Drop UNSET (and empty) so the
 * caller sees `undefined`. */
function normalizeError(s: string): string | undefined {
  if (s === '' || s === 'UNSET') return undefined;
  return s;
}

function normalizeConcStatus(s: string): 'PASS' | 'FAIL' | 'TESTING' | undefined {
  const u = s.toUpperCase();
  return u === 'PASS' || u === 'FAIL' || u === 'TESTING' ? u : undefined;
}

/** Normalize a per-exercise STATUS string from the device. The real
 *  8030 uses `IDLE` for slots that haven't run yet (not `NOT_STARTED`),
 *  so we collapse `IDLE` and the empty string into `NOT_STARTED`. */
function normalizeExerciseStatus(s: string): ExerciseStatus {
  if (s === '' || s === 'IDLE' || s === 'NOT_STARTED') return 'NOT_STARTED';
  if (s === 'TESTING' || s === 'PASS' || s === 'FAIL' || s === 'EXCLUDED') return s;
  return 'NOT_STARTED';
}

/** Parse one `<EXERCISE>` wrapper's children into the snapshot slot
 *  named by its `<INDEX>`. Blocks without a valid INDEX, or with an
 *  INDEX outside [0, MAX_EXERCISES), are ignored. */
function parseExerciseBlock(
  children: OrderedChild[],
  exercises: ExerciseSnapshot[],
): void {
  const block: Partial<ExerciseSnapshot> = {};
  let parsedIdx: number | null = null;
  for (const k of children) {
    const tag = tagNameOf(k);
    if (tag === null) continue;
    const text = childText(k);
    if (tag === 'INDEX') {
      const n = Number.parseInt(text, 10);
      parsedIdx = Number.isFinite(n) ? n : null;
    } else if (tag === 'NAME') {
      block.name = text;
    } else if (tag === 'FITFACTOR') {
      if (text === '') {
        block.fitFactor = null;
      } else {
        const n = Number.parseFloat(text);
        block.fitFactor = Number.isFinite(n) ? n : null;
      }
    } else if (tag === 'STATUS') {
      block.status = normalizeExerciseStatus(text.toUpperCase());
    } else if (tag === 'EXCLUDE') {
      block.excluded = parseBool(text);
    }
  }
  if (parsedIdx === null || parsedIdx < 0 || parsedIdx >= MAX_EXERCISES) return;
  exercises[parsedIdx] = {
    index: parsedIdx,
    name: block.name ?? '',
    fitFactor: block.fitFactor ?? null,
    status: block.status ?? 'NOT_STARTED',
    excluded: block.excluded ?? false,
  };
}

function isTerminalExerciseStatus(s: ExerciseStatus): s is Exclude<ExerciseStatus, 'NOT_STARTED' | 'TESTING' | 'COMPUTING'> {
  return s === 'PASS' || s === 'FAIL' || s === 'EXCLUDED';
}
