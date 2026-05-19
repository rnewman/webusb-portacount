/**
 * Portacount 8030/8038 wire protocol client.
 *
 * Protocol summary:
 *   • Transport: plain TCP, two services on the device:
 *       - port 3603: main XML command/response channel
 *       - port 3602: runtime/liveness probe (request "RSRTLSVC\r\n",
 *         response is an ASCII integer)
 *   • Framing: each XML command is `<MAIN>…</MAIN>` followed by `\r\r`
 *     (two literal CR bytes, no LF). Responses arrive without a length
 *     prefix; we accumulate until we see `\r\r` *or* a quiescent period
 *     elapses after the first byte.
 *   • Session: connect → SYSTEM/ALL → FITPRO_STRING=2.0.0.0 →
 *     LOCK READ → (if UNLOCK) LOCK WRITE REMOTE → UNIT_NUMBER WRITE N.
 *     KeepAlive: send LOCK WRITE KEEPALIVE every 5 s while connected.
 *     Disconnect: LOCK WRITE UNLOCK → TCP close.
 *
 * Layering: byte-stream framing is in {@link ResponseAssembler} — pure,
 * synchronous, tested without timers or stubs. This file owns the
 * orchestration: state machine, per-exchange timers, promise wiring,
 * protocol handshake script.
 *
 * The class is single-connection (LwipStack only manages one TCP PCB at
 * a time). Open/close 3602 first, then open 3603 for the session.
 */

import { XMLParser } from 'fast-xml-parser';

import type { IpOctets, LwipStack } from './lwip-wasm';
import { ResponseAssembler, trimTrailingNulls } from './response-assembler';

export interface DeviceInfo {
  serialNumber: string;
  modelNumber: string;
  buildString: string;
}

const RUNTIME_PORT = 3602;
const PROTOCOL_PORT = 3603;

const CMD_TERMINATOR = '\r\r';

/** Default per-command timeout. */
const DEFAULT_TIMEOUT_MS = 5000;

/** Quiescent window after the first byte; lets us accept responses that
 * don't end in \r\r (some device replies might not). */
const QUIESCENCE_MS = 200;

/** KeepAlive cadence. */
const KEEPALIVE_INTERVAL_MS = 5000;

const utf8 = new TextEncoder();

/**
 * Shape of a parsed XML response from the device. Every leaf is a string
 * (we set `parseTagValue: false` to avoid surprise number coercion;
 * tests want '0' to stay '0', not become 0 or false). All keys are
 * optional — the device only includes the tags relevant to the command.
 */
/** One per-exercise block within a FITTEST/ALL response. The position
 * comes through under the `INDEX` key (the device wraps each per-exercise
 * block under its own `<INDEX>n</INDEX>` element). */
export interface FittestIndexRaw {
  INDEX?: string;
  NAME?: string;
  FITFACTOR?: string;
  STATUS?: string;
  EXCLUDE?: string;
  [tag: string]: unknown;
}

export interface ParsedResponse {
  MAIN?: {
    SYSTEM?: {
      SERIAL_NUMBER?: string;
      MODEL_NUMBER?: string;
      BUILD_STRING?: string;
      FITPRO_STRING?: string;
      LOCK?: string;
      UNIT_NUMBER?: string;
      [tag: string]: string | undefined;
    };
    REALTIME?: {
      AMB_CONC?: string;
      MASK_CONC?: string;
      FITFACTOR?: string;
      MESSAGE?: string;
      STATUS?: string;
      N95_ENABLE?: string;
      COUNT_MODE?: string;
      LOW_ALCOHOL_WARNING?: string;
      [tag: string]: string | undefined;
    };
    FITTEST?: {
      NEWDATA?: string;
      MSG_MAIN?: string;
      FF_OVERALL?: string;
      FF_OVERALL_STATUS?: string;
      STATUS?: string;
      DONE?: string;
      ERROR?: string;
      PROGRESS_PERCENT?: string;
      EXERCISE_NUMBER?: string;
      FF_PASSLEVEL?: string;
      AMB_CONC?: string;
      AMB_CONC_STATUS?: string;
      MASK_CONC?: string;
      MASK_CONC_STATUS?: string;
      SECONDS?: string;
      TOTAL_SECONDS?: string;
      LOW_ALCOHOL_WARNING?: string;
      LOW_PARTICLE_WARNING?: string;
      /** Per-exercise blocks; fast-xml-parser returns one as an object,
       * multiple as an array. The runner normalizes this. */
      INDEX?: FittestIndexRaw | FittestIndexRaw[];
      [tag: string]: unknown;
    };
    DAILYCHECK?: Record<string, string | undefined>;
    MEASUREMENT?: Record<string, string | undefined>;
    DATABASE?: Record<string, string | undefined>;
    ERROR?: string;
    [tag: string]: unknown;
  };
}

const xmlParser = new XMLParser({
  parseTagValue: false,
  trimValues: true,
  ignoreAttributes: true,
});

/**
 * Parse a device response into a structured object. Tolerates trailing
 * `\r\r` and `\0` bytes (the protocol terminator and any trailing buffer
 * padding); attributes are ignored — we only care about element text.
 */
export function parseResponse(xml: string): ParsedResponse {
  return xmlParser.parse(xml) as ParsedResponse;
}

type ConnState = 'idle' | 'connecting' | 'connected' | 'closing';

interface PendingResponse {
  resolve: (data: Uint8Array) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  quiet?: ReturnType<typeof setTimeout>;
}

interface PendingConnect {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingClose {
  resolve: () => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Common XML command builders. */
export const Cmd = {
  systemAll: '<MAIN><SYSTEM><ALL/></SYSTEM></MAIN>',
  fitProString: (v: string) =>
    `<MAIN><SYSTEM><FITPRO_STRING COMMAND="WRITE">${v}</FITPRO_STRING></SYSTEM></MAIN>`,
  lockRead: '<MAIN><SYSTEM><LOCK COMMAND="READ"></LOCK></SYSTEM></MAIN>',
  lockWriteRemote: '<MAIN><SYSTEM><LOCK COMMAND="WRITE">REMOTE</LOCK></SYSTEM></MAIN>',
  lockWriteUnlock: '<MAIN><SYSTEM><LOCK COMMAND="WRITE">UNLOCK</LOCK></SYSTEM></MAIN>',
  lockWriteKeepAlive: '<MAIN><SYSTEM><LOCK COMMAND="WRITE">KEEPALIVE</LOCK></SYSTEM></MAIN>',
  unitNumberWrite: (n: number) =>
    `<MAIN><SYSTEM><UNIT_NUMBER COMMAND="WRITE">${n}</UNIT_NUMBER></SYSTEM></MAIN>`,
  realtimeAll: '<MAIN><REALTIME><ALL/></REALTIME></MAIN>',
  realtimeStart: '<MAIN><REALTIME><START/></REALTIME></MAIN>',
  realtimeStop: '<MAIN><REALTIME><STOP/></REALTIME></MAIN>',
};

/**
 * Optional tracing callbacks for raw XML traffic. Off by default — callers
 * who want to log or display the protocol exchange (e.g. a debug pane in
 * the webapp) wire in `onTx` / `onRx` to receive each full command and
 * response in their entirety (no truncation, no formatting).
 */
export interface PortacountTrace {
  onTx?: (xml: string) => void;
  onRx?: (xml: string) => void;
}

export class Portacount {
  private stack: LwipStack;
  private state: ConnState = 'idle';
  private assembler = new ResponseAssembler();
  private pendingResponse: PendingResponse | null = null;
  private pendingConnect: PendingConnect | null = null;
  private pendingClose: PendingClose | null = null;
  /** When closeTcp is in flight, cache the promise so concurrent callers
   * (e.g. exchange-timeout fires closeTcp, then readRuntime's finally also
   * calls it) all await the same close instead of piling up new pendingClose
   * timers. */
  private closingPromise: Promise<void> | null = null;
  private keepAliveHandle: ReturnType<typeof setInterval> | null = null;
  private logFn: (msg: string) => void;
  private trace: PortacountTrace;
  /** Tail of the command-serialization chain. New commands chain onto this
   * so concurrent callers (poll + keepalive at overlapping intervals) queue
   * instead of racing the single-exchange invariant. */
  private commandTail: Promise<unknown> = Promise.resolve();

  constructor(
    stack: LwipStack,
    logFn: (msg: string) => void = () => {},
    trace: PortacountTrace = {},
  ) {
    this.stack = stack;
    this.logFn = logFn;
    this.trace = trace;
    this.stack.setTcpHandlers({
      onConnected: () => this.onTcpConnected(),
      onData: (data) => this.onTcpData(data),
      onClosed: () => this.onTcpClosed(),
      onError: (err) => this.onTcpError(err),
    });
  }

  /**
   * Probe the device runtime service on port 3602. Returns the integer
   * the device replies with (units undocumented — probably seconds since
   * power-on). Use this as a cheap liveness check.
   */
  async readRuntime(deviceIp: IpOctets, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<number> {
    await this.openTcp(deviceIp, RUNTIME_PORT, timeoutMs);
    try {
      const reply = await this.exchange(utf8.encode('RSRTLSVC\r\n'), timeoutMs);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(reply).trim();
      const n = parseInt(text, 10);
      if (Number.isNaN(n)) {
        throw new Error(`runtime probe: non-integer response ${JSON.stringify(text)}`);
      }
      return n;
    } finally {
      await this.closeTcp();
    }
  }

  /**
   * Open the main XML session on port 3603 and walk the handshake.
   * Returns the device info parsed from the initial SYSTEM/ALL response.
   * After this returns, use {@link command} to issue further XML and
   * (optionally) {@link startKeepAlive} to hold the remote lock.
   */
  async connect(deviceIp: IpOctets, unitNumber = 1): Promise<DeviceInfo> {
    await this.openTcp(deviceIp, PROTOCOL_PORT, DEFAULT_TIMEOUT_MS);

    const sysAllRaw = await this.command(Cmd.systemAll);
    const sysAll = parseResponse(sysAllRaw);
    const sys = sysAll.MAIN?.SYSTEM;
    if (!sys?.SERIAL_NUMBER) {
      await this.closeTcp();
      throw new Error(`handshake: SYSTEM/ALL reply missing SERIAL_NUMBER: ${sysAllRaw.slice(0, 120)}`);
    }
    const info: DeviceInfo = {
      serialNumber: sys.SERIAL_NUMBER,
      modelNumber: sys.MODEL_NUMBER ?? '',
      buildString: sys.BUILD_STRING ?? '',
    };
    this.logFn(`[handshake] device SN=${info.serialNumber} model=${info.modelNumber} build=${info.buildString}`);

    await this.command(Cmd.fitProString('2.0.0.0'));

    const lockReplyRaw = await this.command(Cmd.lockRead);
    const lockState = parseResponse(lockReplyRaw).MAIN?.SYSTEM?.LOCK;
    if (lockState === 'UNLOCK') {
      this.logFn('[handshake] device UNLOCK — taking REMOTE lock');
      await this.command(Cmd.lockWriteRemote);
    } else {
      this.logFn(`[handshake] device lock state: ${lockState ?? '?'}`);
    }

    await this.command(Cmd.unitNumberWrite(unitNumber));

    return info;
  }

  /**
   * Send an XML command (with `\r\r` appended) and resolve to the
   * response as UTF-8 text. Throws on timeout or TCP error.
   *
   * Concurrent callers (e.g. a 1 s realtime poll racing the 5 s keepalive)
   * are serialized: each command waits for the prior one to settle before
   * it touches `exchange()`. The connection-state check still runs at the
   * moment of dispatch, so a queued command can fail with
   * `not connected (state=…)` if the link dropped while it was waiting.
   */
  command(xml: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    const run = async (): Promise<string> => {
      if (this.state !== 'connected') {
        throw new Error(`command: not connected (state=${this.state})`);
      }
      const payload = utf8.encode(xml + CMD_TERMINATOR);
      this.trace.onTx?.(xml);
      const raw = await this.exchange(payload, timeoutMs);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(trimTrailingNulls(raw));
      this.trace.onRx?.(text);
      return text;
    };
    const result = this.commandTail.then(run, run);
    // Swallow rejections on the tail so one failure doesn't poison the queue;
    // the original `result` still rejects for the caller.
    this.commandTail = result.catch(() => undefined);
    return result;
  }

  /**
   * Send LOCK=KEEPALIVE every 5 s on the active session, so the device
   * doesn't drop the remote lock. Safe to call after {@link connect}.
   */
  startKeepAlive(): void {
    if (this.keepAliveHandle !== null) return;
    this.keepAliveHandle = setInterval(() => {
      if (this.state !== 'connected') return;
      this.command(Cmd.lockWriteKeepAlive).catch((err) =>
        this.logFn(`[keepalive] failed: ${(err as Error).message}`),
      );
    }, KEEPALIVE_INTERVAL_MS);
  }

  /** Stop the keep-alive timer. */
  stopKeepAlive(): void {
    if (this.keepAliveHandle !== null) {
      clearInterval(this.keepAliveHandle);
      this.keepAliveHandle = null;
    }
  }

  /**
   * Release the remote lock and close the TCP session. Safe to call
   * even if not fully connected.
   */
  async disconnect(): Promise<void> {
    this.stopKeepAlive();
    if (this.state === 'connected') {
      try {
        await this.command(Cmd.lockWriteUnlock, 2000);
      } catch (err) {
        this.logFn(`[disconnect] LOCK=UNLOCK failed (continuing): ${(err as Error).message}`);
      }
    }
    if (this.state === 'connected' || this.state === 'connecting') {
      await this.closeTcp();
    }
  }

  // ---- internal connection helpers ----

  private async openTcp(ip: IpOctets, port: number, timeoutMs: number): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`openTcp: bad state ${this.state}`);
    }
    this.state = 'connecting';
    this.assembler.reset();

    await new Promise<void>((resolve, reject) => {
      this.pendingConnect = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pendingConnect = null;
          this.state = 'idle';
          try { this.stack.tcpClose(); } catch { /* ignore */ }
          reject(new Error(`tcp connect ${ip.join('.')}:${port} timed out after ${timeoutMs}ms`));
        }, timeoutMs),
      };
      try {
        this.stack.tcpConnect(ip, port);
      } catch (err) {
        clearTimeout(this.pendingConnect.timer);
        this.pendingConnect = null;
        this.state = 'idle';
        reject(err as Error);
      }
    });
  }

  private closeTcp(timeoutMs = 2000): Promise<void> {
    if (this.state === 'idle') return Promise.resolve();
    if (this.closingPromise) return this.closingPromise;

    this.state = 'closing';
    try {
      this.stack.tcpClose();
    } catch { /* ignore */ }

    this.closingPromise = new Promise<void>((resolve) => {
      this.pendingClose = {
        resolve,
        timer: setTimeout(() => {
          // Even if we never see FIN, free our state.
          this.pendingClose = null;
          this.state = 'idle';
          resolve();
        }, timeoutMs),
      };
    }).finally(() => {
      this.closingPromise = null;
    });
    return this.closingPromise;
  }

  /**
   * Write `payload` and wait for the next response (terminator or quiet).
   *
   * Invariant: at any moment there is at most one pendingResponse, and the
   * assembler holds bytes only for that response (we reset it on entry).
   * If the timeout fires, we also tear down the TCP connection — this
   * matters because the device may still send a (late) response, and
   * without the close those bytes could land in the assembler while a
   * subsequent exchange is in flight, resolving the new exchange with
   * the previous request's response. Closing forces the user to
   * reconnect, which guarantees a clean wire.
   */
  private exchange(payload: Uint8Array, timeoutMs: number): Promise<Uint8Array> {
    if (this.pendingResponse) {
      return Promise.reject(new Error('exchange: another exchange is in flight'));
    }
    this.assembler.reset();
    return new Promise<Uint8Array>((resolve, reject) => {
      this.pendingResponse = {
        resolve: (data) => {
          this.clearResponseTimers();
          this.pendingResponse = null;
          resolve(data);
        },
        reject: (err) => {
          this.clearResponseTimers();
          this.pendingResponse = null;
          reject(err);
        },
        timer: setTimeout(() => {
          if (this.pendingResponse) {
            this.pendingResponse.reject(new Error(`exchange: timeout after ${timeoutMs}ms`));
          }
          // Tear down so late bytes for the timed-out request can't
          // leak into a subsequent exchange. closeTcp is idempotent
          // when already in-flight, so callers above (e.g. readRuntime's
          // finally) won't double-close.
          if (this.state === 'connected') {
            this.closeTcp().catch(() => { /* swallow — caller already rejected */ });
          }
        }, timeoutMs),
      };
      try {
        this.stack.tcpWrite(payload);
      } catch (err) {
        if (this.pendingResponse) this.pendingResponse.reject(err as Error);
      }
    });
  }

  private clearResponseTimers(): void {
    if (this.pendingResponse) {
      clearTimeout(this.pendingResponse.timer);
      if (this.pendingResponse.quiet) clearTimeout(this.pendingResponse.quiet);
    }
  }

  // ---- TCP event handlers (wired in constructor) ----

  private onTcpConnected(): void {
    if (this.pendingConnect) {
      clearTimeout(this.pendingConnect.timer);
      const { resolve } = this.pendingConnect;
      this.pendingConnect = null;
      this.state = 'connected';
      resolve();
    }
  }

  private onTcpData(data: Uint8Array): void {
    const result = this.assembler.push(data);
    const pending = this.pendingResponse;
    if (!pending) return;

    if (result.kind === 'complete') {
      pending.resolve(result.bytes);
      return;
    }
    // Incomplete — reset the quiescent-completion window.
    if (pending.quiet) clearTimeout(pending.quiet);
    pending.quiet = setTimeout(() => {
      if (this.pendingResponse) {
        this.pendingResponse.resolve(this.assembler.takeBuffered());
      }
    }, QUIESCENCE_MS);
  }

  private onTcpClosed(): void {
    const wasConnecting = this.pendingConnect;
    const wasResponse = this.pendingResponse;
    const wasClosing = this.pendingClose;
    this.state = 'idle';

    if (wasClosing) {
      clearTimeout(wasClosing.timer);
      this.pendingClose = null;
      wasClosing.resolve();
    }
    if (wasConnecting) {
      clearTimeout(wasConnecting.timer);
      this.pendingConnect = null;
      wasConnecting.reject(new Error('tcp closed during connect'));
    }
    if (wasResponse) {
      // If we already have any data, treat close-by-peer as end-of-response
      // (port 3602 closes after the runtime int).
      if (this.assembler.pending > 0) {
        wasResponse.resolve(this.assembler.takeBuffered());
      } else {
        wasResponse.reject(new Error('tcp closed before response'));
      }
    }
  }

  private onTcpError(err: number): void {
    const wasConnecting = this.pendingConnect;
    const wasResponse = this.pendingResponse;
    const wasClosing = this.pendingClose;
    this.state = 'idle';

    const e = new Error(`tcp error code=${err}`);
    if (wasConnecting) {
      clearTimeout(wasConnecting.timer);
      this.pendingConnect = null;
      wasConnecting.reject(e);
    }
    if (wasResponse) {
      wasResponse.reject(e);
    }
    if (wasClosing) {
      clearTimeout(wasClosing.timer);
      this.pendingClose = null;
      wasClosing.resolve();
    }
  }
}
