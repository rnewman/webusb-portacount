/**
 * IndexedDB-backed storage for completed fit tests, separate from the
 * realtime-sampling store. Mirrors `session-store.ts` in shape:
 *
 *   fittests         (keyPath: startedAt)      — one row per run
 *   fittest_samples  (autoincrement, by_test)  — one row per FITTEST/ALL poll
 *
 * A fit-test row carries the inputs (person/mask/protocol/start) and the
 * final result; samples carry per-poll AMB/MASK readings for charting.
 */

import type {
  ExerciseResult,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestStartOptions,
} from 'webusb-portacount';

const DB_NAME = 'webusb-portacount-fittests';
const DB_VERSION = 1;
const STORE_TESTS = 'fittests';
const STORE_SAMPLES = 'fittest_samples';
const INDEX_BY_TEST = 'by_test';

export interface FitTestRecord {
  startedAt: number;
  endedAt?: number;
  deviceSn: string;
  deviceModel: string;
  deviceBuild: string;
  person: FitTestPerson;
  mask: FitTestMask;
  protocol: FitTestProtocolDef;
  start: FitTestStartOptions;
  result?: {
    ffOverall: number | null;
    ffOverallStatus?: 'PASS' | 'FAIL';
    error?: string;
    exercises: ExerciseResult[];
  };
  /** When aborted/errored, a human label that explains why. */
  aborted?: string;
}

export interface FitTestSampleRecord {
  testId: number;
  /** Milliseconds since `startedAt`. */
  t: number;
  amb: number;
  mask: number;
  ambStatus?: 'PASS' | 'FAIL' | 'TESTING';
  maskStatus?: 'PASS' | 'FAIL' | 'TESTING';
}

export interface FitTestStore {
  startTest(meta: Omit<FitTestRecord, 'startedAt' | 'endedAt' | 'result' | 'aborted'>): Promise<number>;
  recordSample(s: FitTestSampleRecord): Promise<void>;
  endTest(testId: number, endedAt: number, result?: FitTestRecord['result'], aborted?: string): Promise<void>;
  /** Patch the labeling fields on an existing record (person, mask, notes).
   *  Used for after-the-fact relabeling — does not touch result/samples. */
  updateLabels(testId: number, patch: { person?: Partial<FitTestPerson>; mask?: Partial<FitTestMask> }): Promise<void>;
  /** Newest first. */
  listTests(): Promise<FitTestRecord[]>;
  getSamples(testId: number): Promise<FitTestSampleRecord[]>;
  deleteTest(testId: number): Promise<void>;
  clearAll(): Promise<void>;
}

export async function openFitTestStore(): Promise<FitTestStore> {
  const db = await openDb();
  return makeStore(db);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_TESTS)) {
        db.createObjectStore(STORE_TESTS, { keyPath: 'startedAt' });
      }
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        const samples = db.createObjectStore(STORE_SAMPLES, { autoIncrement: true });
        samples.createIndex(INDEX_BY_TEST, 'testId', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('openDb failed'));
  });
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB request failed'));
  });
}

function makeStore(db: IDBDatabase): FitTestStore {
  return {
    async startTest(meta) {
      const startedAt = Date.now();
      const row: FitTestRecord = { startedAt, ...meta };
      const tx = db.transaction(STORE_TESTS, 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_TESTS).add(row));
      return startedAt;
    },
    async recordSample(s) {
      const tx = db.transaction(STORE_SAMPLES, 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_SAMPLES).add(s));
    },
    async endTest(testId, endedAt, result, aborted) {
      const tx = db.transaction(STORE_TESTS, 'readwrite');
      const store = tx.objectStore(STORE_TESTS);
      const existing = (await reqAsPromise(store.get(testId))) as FitTestRecord | undefined;
      if (!existing) return;
      existing.endedAt = endedAt;
      if (result) existing.result = result;
      if (aborted) existing.aborted = aborted;
      await reqAsPromise(store.put(existing));
    },
    async updateLabels(testId, patch) {
      const tx = db.transaction(STORE_TESTS, 'readwrite');
      const store = tx.objectStore(STORE_TESTS);
      const existing = (await reqAsPromise(store.get(testId))) as FitTestRecord | undefined;
      if (!existing) return;
      if (patch.person) existing.person = { ...existing.person, ...patch.person };
      if (patch.mask) existing.mask = { ...existing.mask, ...patch.mask };
      await reqAsPromise(store.put(existing));
    },
    async listTests() {
      const tx = db.transaction(STORE_TESTS, 'readonly');
      const all = (await reqAsPromise(tx.objectStore(STORE_TESTS).getAll())) as FitTestRecord[];
      return all.sort((a, b) => b.startedAt - a.startedAt);
    },
    async getSamples(testId) {
      const tx = db.transaction(STORE_SAMPLES, 'readonly');
      const idx = tx.objectStore(STORE_SAMPLES).index(INDEX_BY_TEST);
      const samples = (await reqAsPromise(idx.getAll(IDBKeyRange.only(testId)))) as FitTestSampleRecord[];
      return samples.sort((a, b) => a.t - b.t);
    },
    async deleteTest(testId) {
      const txS = db.transaction(STORE_SAMPLES, 'readwrite');
      const idx = txS.objectStore(STORE_SAMPLES).index(INDEX_BY_TEST);
      await new Promise<void>((resolve, reject) => {
        const cursorReq = idx.openCursor(IDBKeyRange.only(testId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
          else resolve();
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('cursor failed'));
      });
      const txM = db.transaction(STORE_TESTS, 'readwrite');
      await reqAsPromise(txM.objectStore(STORE_TESTS).delete(testId));
    },
    async clearAll() {
      const tx = db.transaction([STORE_TESTS, STORE_SAMPLES], 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_TESTS).clear());
      await reqAsPromise(tx.objectStore(STORE_SAMPLES).clear());
    },
  };
}
