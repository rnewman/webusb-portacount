/**
 * WebSocket-backed {@link ByteStream}.
 *
 * The standalone simulator (`simulator/portacount-8020.ts`) exposes
 * the 8020 wire protocol over a WebSocket — each frame is a chunk of
 * bytes in either direction. This adapter lets the webapp and tests
 * speak to the simulator through the same {@link ByteStream} API
 * they use for real serial ports.
 */

import type { ByteStream } from '../byte-stream';

export interface WebSocketByteStreamOptions {
  /** URL to connect to. Default: `ws://localhost:18020`. */
  url?: string;
  /** Optional logging hook for lifecycle / errors. */
  log?: (msg: string) => void;
}

export class WebSocketByteStream implements ByteStream {
  readonly info: { label: string };
  private socket: WebSocket | null = null;
  private cb: ((c: Uint8Array) => void) | null = null;
  private closed = false;
  private opening: Promise<void> | null = null;
  private writeQueue: Uint8Array[] = [];
  private log: (msg: string) => void;

  constructor(opts: WebSocketByteStreamOptions = {}) {
    const url = opts.url ?? 'ws://localhost:18020';
    this.info = { label: url };
    this.log = opts.log ?? (() => undefined);
    this.opening = this.open(url);
  }

  private open(url: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let s: WebSocket;
      try {
        s = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }
      s.binaryType = 'arraybuffer';
      this.socket = s;

      s.addEventListener('open', () => {
        // Flush anything buffered before open.
        const queued = this.writeQueue;
        this.writeQueue = [];
        for (const chunk of queued) s.send(chunk);
        resolve();
      });
      s.addEventListener('error', (ev) => {
        this.log(`[ws] error: ${(ev as ErrorEvent).message ?? 'unknown'}`);
        if (this.opening !== null) {
          reject(new Error('WebSocket failed to open'));
        }
      });
      s.addEventListener('close', () => {
        this.closed = true;
      });
      s.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data;
        let bytes: Uint8Array | null = null;
        if (data instanceof ArrayBuffer) {
          bytes = new Uint8Array(data);
        } else if (typeof data === 'string') {
          bytes = new TextEncoder().encode(data);
        } else if (ArrayBuffer.isView(data)) {
          bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        if (bytes && this.cb) this.cb(bytes);
      });
    });
  }

  /** Resolve once the socket is open. The webapp can choose to await
   * this before issuing commands. */
  ready(): Promise<void> {
    return this.opening ?? Promise.resolve();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error('WebSocketByteStream: closed');
    const s = this.socket;
    if (s === null || s.readyState === WebSocket.CONNECTING) {
      this.writeQueue.push(bytes);
      return;
    }
    if (s.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocketByteStream: socket not open (state=${s.readyState})`);
    }
    s.send(bytes);
  }

  onData(cb: ((c: Uint8Array) => void) | null): void {
    this.cb = cb;
  }

  async close(): Promise<void> {
    this.closed = true;
    const s = this.socket;
    this.socket = null;
    if (s && s.readyState !== WebSocket.CLOSED) {
      s.close();
    }
  }
}
