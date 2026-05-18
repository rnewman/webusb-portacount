/**
 * IndexedDB-backed storage for sampling sessions.
 *
 * Normalized schema so live polling appends one tiny record per second
 * rather than rewriting a growing array:
 *
 *   sessions  (keyPath: startedAt)  → one row per Start/Stop cycle
 *   samples   (autoincrement,
 *              index by_session on sessionId)
 *                                   → one row per polled REALTIME reading
 *
 * Sample ids and session lifecycle never collide because `startedAt` is
 * `Date.now()` at the moment of Start sampling — within a single tab
 * it's monotonic, and across tabs the chance of collision is
 * astronomically small (you'd need to click Start in two tabs within
 * the same millisecond).
 */

const DB_NAME = 'portacount-webusb';
const DB_VERSION = 1;
const STORE_SESSIONS = 'sessions';
const STORE_SAMPLES = 'samples';
const INDEX_BY_SESSION = 'by_session';

export interface SessionRecord {
  /** Epoch ms; also the primary key. */
  startedAt: number;
  /** Epoch ms; undefined while the session is still active. */
  endedAt?: number;
  deviceSn: string;
  deviceModel: string;
  deviceBuild: string;
}

export interface SampleRecord {
  sessionId: number;
  /** Milliseconds since the session's `startedAt`. */
  t: number;
  amb: number;
  mask: number;
  ff: number;
  status: string;
  msg: string;
  lowAlcohol: boolean;
}

export interface SessionStore {
  /** Insert a new session row. Resolves to the row's id (== startedAt). */
  startSession(meta: Omit<SessionRecord, 'startedAt' | 'endedAt'>): Promise<number>;
  recordSample(sample: SampleRecord): Promise<void>;
  endSession(sessionId: number, endedAt: number): Promise<void>;
  /** Newest first. */
  listSessions(): Promise<SessionRecord[]>;
  getSamples(sessionId: number): Promise<SampleRecord[]>;
  deleteSession(sessionId: number): Promise<void>;
  clearAll(): Promise<void>;
}

export async function openSessionStore(): Promise<SessionStore> {
  const db = await openDb();
  return makeStore(db);
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'startedAt' });
      }
      if (!db.objectStoreNames.contains(STORE_SAMPLES)) {
        const samples = db.createObjectStore(STORE_SAMPLES, { autoIncrement: true });
        samples.createIndex(INDEX_BY_SESSION, 'sessionId', { unique: false });
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

function makeStore(db: IDBDatabase): SessionStore {
  return {
    async startSession(meta) {
      const startedAt = Date.now();
      const record: SessionRecord = { startedAt, ...meta };
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_SESSIONS).add(record));
      return startedAt;
    },

    async recordSample(sample) {
      const tx = db.transaction(STORE_SAMPLES, 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_SAMPLES).add(sample));
    },

    async endSession(sessionId, endedAt) {
      const tx = db.transaction(STORE_SESSIONS, 'readwrite');
      const store = tx.objectStore(STORE_SESSIONS);
      const existing = await reqAsPromise(store.get(sessionId)) as SessionRecord | undefined;
      if (!existing) return;
      existing.endedAt = endedAt;
      await reqAsPromise(store.put(existing));
    },

    async listSessions() {
      const tx = db.transaction(STORE_SESSIONS, 'readonly');
      const all = await reqAsPromise(tx.objectStore(STORE_SESSIONS).getAll()) as SessionRecord[];
      return all.sort((a, b) => b.startedAt - a.startedAt);
    },

    async getSamples(sessionId) {
      const tx = db.transaction(STORE_SAMPLES, 'readonly');
      const idx = tx.objectStore(STORE_SAMPLES).index(INDEX_BY_SESSION);
      const samples = await reqAsPromise(idx.getAll(IDBKeyRange.only(sessionId))) as SampleRecord[];
      return samples.sort((a, b) => a.t - b.t);
    },

    async deleteSession(sessionId) {
      // Two transactions; the second one needs the cursor for the
      // by-session index. Order: samples first so an interrupted
      // delete doesn't orphan rows.
      const txS = db.transaction(STORE_SAMPLES, 'readwrite');
      const idx = txS.objectStore(STORE_SAMPLES).index(INDEX_BY_SESSION);
      await new Promise<void>((resolve, reject) => {
        const cursorReq = idx.openCursor(IDBKeyRange.only(sessionId));
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error ?? new Error('delete-samples cursor failed'));
      });

      const txM = db.transaction(STORE_SESSIONS, 'readwrite');
      await reqAsPromise(txM.objectStore(STORE_SESSIONS).delete(sessionId));
    },

    async clearAll() {
      const tx = db.transaction([STORE_SESSIONS, STORE_SAMPLES], 'readwrite');
      await reqAsPromise(tx.objectStore(STORE_SESSIONS).clear());
      await reqAsPromise(tx.objectStore(STORE_SAMPLES).clear());
    },
  };
}
