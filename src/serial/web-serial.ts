/**
 * Web Serial-backed {@link ByteStream}.
 *
 * Wraps a {@link SerialPort} from the Web Serial API. The port must
 * already be obtained via `navigator.serial.requestPort()` /
 * `navigator.serial.getPorts()` and (optionally) `open()`-ed; we
 * accept either pre-opened or unopened ports and finish setup
 * ourselves.
 *
 * PortaCount 8020 default UART parameters: 1200 bps, 8N1. The cable
 * is null-modem-style (TSI specifies a specific DB9 wiring — see
 * `adapter/physical-cable.md`).
 */

import type { ByteStream } from '../byte-stream';

export interface WebSerialOpenParams {
  /** Bits/second. PortaCount 8020 default is 1200; DIP switches can
   * select up to 9600 in some firmwares. */
  baudRate?: number;
  /** Data bits. Default 8. */
  dataBits?: 7 | 8;
  /** Stop bits. Default 1. */
  stopBits?: 1 | 2;
  /** Parity. Default 'none'. */
  parity?: 'none' | 'even' | 'odd';
  /** Hardware flow control. Default 'none'. */
  flowControl?: 'none' | 'hardware';
  /** Buffer size for the readable stream. Default 1024. */
  bufferSize?: number;
}

/** Minimal Web Serial typings — the official @types/web are not in
 * this repo's devDependencies, but the runtime shape is stable. */
export interface WebSerialPortLike {
  open(options: WebSerialOpenParams): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

export interface WebSerialByteStreamOptions {
  /** When true, call `port.open(...)` ourselves. When false, the
   * caller has already opened the port. Default: true. */
  openPort?: boolean;
  /** Parameters for `port.open()` — ignored if `openPort` is false. */
  openParams?: WebSerialOpenParams;
  /** Human-readable label for `info`. Default derived from
   * `port.getInfo()`. */
  label?: string;
  /** Optional logging hook. */
  log?: (msg: string) => void;
}

const DEFAULT_OPEN_PARAMS: Required<Pick<WebSerialOpenParams, 'baudRate' | 'dataBits' | 'stopBits' | 'parity' | 'flowControl'>> = {
  baudRate: 1200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  flowControl: 'none',
};

export class WebSerialByteStream implements ByteStream {
  readonly info: { label: string };
  private port: WebSerialPortLike;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readLoopDone: Promise<void> | null = null;
  private cb: ((c: Uint8Array) => void) | null = null;
  private opened = false;
  private closed = false;
  private opening: Promise<void>;
  private log: (msg: string) => void;

  constructor(port: WebSerialPortLike, opts: WebSerialByteStreamOptions = {}) {
    this.port = port;
    this.log = opts.log ?? (() => undefined);
    const info = port.getInfo?.();
    const vendor = info?.usbVendorId?.toString(16) ?? '?';
    const product = info?.usbProductId?.toString(16) ?? '?';
    this.info = {
      label:
        opts.label ??
        `serial (vid=${vendor} pid=${product} @ ${
          opts.openParams?.baudRate ?? DEFAULT_OPEN_PARAMS.baudRate
        })`,
    };
    this.opening = this.openIfNeeded(opts);
  }

  /** Resolve once the port is open and the read loop is running.
   * Callers should `await stream.ready()` before issuing commands. */
  ready(): Promise<void> {
    return this.opening;
  }

  private async openIfNeeded(opts: WebSerialByteStreamOptions): Promise<void> {
    const shouldOpen = opts.openPort ?? true;
    if (shouldOpen) {
      const params: WebSerialOpenParams = { ...DEFAULT_OPEN_PARAMS, ...opts.openParams };
      this.log(`[serial] opening port ${this.info.label}`);
      await this.port.open(params);
    }
    this.opened = true;
    this.startReadLoop();
  }

  private startReadLoop(): void {
    if (this.port.readable === null) {
      throw new Error('WebSerialByteStream: port.readable is null after open()');
    }
    this.reader = this.port.readable.getReader();
    this.readLoopDone = (async () => {
      try {
        while (true) {
          const { value, done } = await this.reader!.read();
          if (done) break;
          if (value && value.length > 0 && this.cb) this.cb(value);
        }
      } catch (err) {
        this.log(`[serial] read loop error: ${(err as Error).message}`);
      } finally {
        try {
          this.reader?.releaseLock();
        } catch {
          /* ignore */
        }
        this.reader = null;
      }
    })();
  }

  async write(bytes: Uint8Array): Promise<void> {
    await this.opening;
    if (this.closed) throw new Error('WebSerialByteStream: closed');
    if (this.port.writable === null) {
      throw new Error('WebSerialByteStream: port.writable is null');
    }
    if (this.writer === null) this.writer = this.port.writable.getWriter();
    await this.writer.write(bytes);
  }

  onData(cb: ((c: Uint8Array) => void) | null): void {
    this.cb = cb;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Cancel the read loop first so the readable stream releases.
    try {
      await this.reader?.cancel();
    } catch (err) {
      this.log(`[serial] reader.cancel error: ${(err as Error).message}`);
    }

    // Wait for the read loop to settle so subsequent close() observes
    // the cancellation cleanly.
    try {
      await this.readLoopDone;
    } catch {
      /* swallow */
    }

    // Release the writer lock.
    if (this.writer) {
      try {
        await this.writer.close();
      } catch (err) {
        this.log(`[serial] writer.close error: ${(err as Error).message}`);
      } finally {
        try {
          this.writer.releaseLock();
        } catch {
          /* ignore */
        }
        this.writer = null;
      }
    }

    if (this.opened) {
      try {
        await this.port.close();
      } catch (err) {
        this.log(`[serial] port.close error: ${(err as Error).message}`);
      }
    }
  }
}
