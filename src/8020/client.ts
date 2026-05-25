/**
 * PortaCount 8020 client.
 *
 * Wires {@link ByteStream} → {@link LineAssembler} → {@link parseLine}
 * → {@link reduce} → subscribers. Owns the command queue
 * ({@link CommandQueue8020}) and the connection state machine.
 *
 * The 8030 client ({@link Portacount}) drives a complex XML
 * conversation; this one is much simpler — most of the work is just
 * receiving lines and reducing them to state. The interesting parts
 * are the connect lifecycle and the sync-on-connect command sequence.
 */

import type { ByteStream } from '../byte-stream';
import {
  BootBannerCollector,
  type DeviceIdentity8020,
} from './boot-banner';
import { CommandQueue8020, type CommandOptions } from './command-queue';
import { LineAssembler } from './line-assembler';
import { parseLine, type ParsedEvent, type UnknownLine } from './parser';
import { Cmd8020 } from './patterns';
import {
  emptyState,
  reduce,
  type Portacount8020State,
} from './state';

export type ConnectionState8020 = 'idle' | 'connecting' | 'ready' | 'closing' | 'closed';

export interface Portacount8020Options {
  /** Optional logging hook for command/data/lifecycle messages. */
  log?: (msg: string) => void;
}

export interface SyncOnConnectOptions {
  /** Attempt to seize external control. The device's reply (`OK` /
   * `EJ`) is awaited. Defaults to false — taking control surprises
   * users who started the device under its own steam. */
  enableExternalControl?: boolean;
  /** Enable continuous data transmission after connect. Only useful
   * when also enabling external control (the internal-mode data
   * stream is enabled by the device itself). */
  enableDataTransmission?: boolean;
  /** Request the full settings burst on connect. Defaults to true —
   * cheap and useful for UI labels. */
  requestSettings?: boolean;
  /** Request runtime status (battery / pulse). Defaults to true. */
  requestRuntimeStatus?: boolean;
  /** Per-command timeout for the sync sequence. */
  timeoutMs?: number;
}

export type Listener<T> = (value: T) => void;
export type Unsubscribe = () => void;

export class Portacount8020 {
  private stream: ByteStream | null = null;
  private connectionState: ConnectionState8020 = 'idle';
  private state: Portacount8020State = emptyState();
  private assembler = new LineAssembler();
  private queue: CommandQueue8020;
  private banner = new BootBannerCollector();
  private stateListeners = new Set<Listener<Portacount8020State>>();
  private lineListeners = new Set<Listener<string>>();
  private eventListeners = new Set<Listener<ParsedEvent | UnknownLine>>();
  private connectionListeners = new Set<Listener<ConnectionState8020>>();
  private identityListeners = new Set<Listener<DeviceIdentity8020>>();
  private log: (msg: string) => void;

  constructor(opts: Portacount8020Options = {}) {
    this.log = opts.log ?? (() => undefined);
    this.queue = new CommandQueue8020({
      write: (bytes) => this.writeBytes(bytes),
      onUnsolicitedLine: (line) => this.handleLine(line),
      log: this.log,
    });
    this.banner.subscribe((id) => {
      for (const cb of this.identityListeners) {
        try {
          cb(id);
        } catch (err) {
          this.log(`[8020 identity listener] threw: ${(err as Error).message}`);
        }
      }
    });
  }

  /** Current connection state. */
  get connection(): ConnectionState8020 {
    return this.connectionState;
  }

  /** Current device-state snapshot. */
  get snapshot(): Portacount8020State {
    return this.state;
  }

  /** Last-observed device identity (firmware version, S/N, DIP
   * switches, etc.) accumulated from the power-on boot banner. The
   * banner is only emitted at device power-on; if we connect to an
   * already-running device, `identity.complete` stays false. */
  get identity(): DeviceIdentity8020 {
    return this.banner.identity;
  }

  /** Subscribe to state snapshots. The reducer returns a new object
   * only when something changed; listeners receive the new snapshot
   * (not a diff). */
  onState(cb: Listener<Portacount8020State>): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  /** Subscribe to raw inbound lines, useful for a debug log pane. */
  onLine(cb: Listener<string>): Unsubscribe {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  /** Subscribe to parsed events (the discriminated union output of
   * {@link parseLine}). Lines that parsed to `unknown` are also
   * delivered, so a runner can collect every event. */
  onEvent(cb: Listener<ParsedEvent | UnknownLine>): Unsubscribe {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  /** Subscribe to connection-state transitions. */
  onConnection(cb: Listener<ConnectionState8020>): Unsubscribe {
    this.connectionListeners.add(cb);
    return () => this.connectionListeners.delete(cb);
  }

  /** Subscribe to identity updates. Fires on every banner-* line
   * that updates the accumulated identity (firmware version,
   * settings, DIP switches). The terminal call carries
   * `identity.complete === true`. */
  onIdentity(cb: Listener<DeviceIdentity8020>): Unsubscribe {
    this.identityListeners.add(cb);
    return () => this.identityListeners.delete(cb);
  }

  /**
   * Adopt a {@link ByteStream} as the device transport. The stream's
   * `onData` is bound to the line assembler; the queue's `write`
   * routes through `stream.write`. Optionally runs a sync-on-connect
   * sequence; throws if any of those commands fail (the underlying
   * stream is left open, so the caller can choose whether to retry
   * or {@link disconnect}).
   */
  async connect(stream: ByteStream, sync: SyncOnConnectOptions = {}): Promise<void> {
    if (this.connectionState !== 'idle' && this.connectionState !== 'closed') {
      throw new Error(`connect: bad state ${this.connectionState}`);
    }
    this.stream = stream;
    this.assembler.reset();
    this.state = emptyState();
    this.banner.reset();
    this.setConnection('connecting');
    stream.onData((chunk) => this.ingestBytes(chunk));

    const requestSettings = sync.requestSettings ?? true;
    const requestRuntimeStatus = sync.requestRuntimeStatus ?? true;
    const timeoutMs = sync.timeoutMs;
    const cmdOpts: CommandOptions = timeoutMs !== undefined ? { timeoutMs } : {};

    try {
      if (sync.enableExternalControl) {
        await this.queue.command(Cmd8020.invokeExternal, cmdOpts);
      }
      if (sync.enableDataTransmission) {
        await this.queue.command(Cmd8020.dataTxEnable, cmdOpts);
      }
      if (requestRuntimeStatus) {
        await this.queue.command(Cmd8020.runtimeStatus, cmdOpts);
      }
      if (requestSettings) {
        // The settings burst is multi-line with no clean terminator.
        // We don't gate the queue on it — fire `S` and treat the
        // result as a write-only event; the settings lines arrive on
        // the unsolicited channel and accumulate via the reducer.
        // The echo of `S` is the immediate ack.
        await this.queue
          .command(Cmd8020.settings, cmdOpts)
          .catch((err) => {
            // `S` does not echo on every firmware — log and continue.
            this.log(`[8020 connect] settings request failed: ${(err as Error).message}`);
          });
      }
    } catch (err) {
      this.setConnection('idle');
      throw err;
    }

    this.setConnection('ready');
  }

  /** Send a raw command. Echo-ack and override-pattern matching is
   * handled by the command queue. */
  command(cmd: string, opts?: CommandOptions): Promise<string> {
    return this.queue.command(cmd, opts);
  }

  /** Convenience: invoke external control. Resolves once the device
   * acks with `OK` or `EJ`. */
  enableExternalControl(opts?: CommandOptions): Promise<string> {
    return this.queue.command(Cmd8020.invokeExternal, opts);
  }

  /** Convenience: release external control. */
  releaseExternalControl(opts?: CommandOptions): Promise<string> {
    return this.queue.command(Cmd8020.releaseExternal, opts);
  }

  /** Convenience: enable continuous data transmission. */
  enableDataTransmission(opts?: CommandOptions): Promise<string> {
    return this.queue.command(Cmd8020.dataTxEnable, opts);
  }

  /** Convenience: disable continuous data transmission. */
  disableDataTransmission(opts?: CommandOptions): Promise<string> {
    return this.queue.command(Cmd8020.dataTxDisable, opts);
  }

  /** Convenience: request all settings. The settings lines arrive on
   * the unsolicited channel and are reduced into `snapshot.settings`. */
  requestSettings(opts?: CommandOptions): Promise<string> {
    return this.queue.command(Cmd8020.settings, opts);
  }

  /** Disconnect from the device. Closes the byte stream and rejects
   * any in-flight commands. Safe to call from any state. */
  async disconnect(): Promise<void> {
    if (this.connectionState === 'idle' || this.connectionState === 'closed') return;
    this.setConnection('closing');
    this.queue.close(new Error('disconnect'));
    const s = this.stream;
    this.stream = null;
    if (s) {
      try {
        s.onData(null);
      } catch {
        // some implementations may not support null detach
      }
      try {
        await s.close();
      } catch (err) {
        this.log(`[8020 disconnect] close error: ${(err as Error).message}`);
      }
    }
    this.setConnection('closed');
  }

  // ---- internals ----

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    if (this.stream === null) throw new Error('write: no stream');
    await this.stream.write(bytes);
  }

  private ingestBytes(chunk: Uint8Array): void {
    const lines = this.assembler.push(chunk);
    for (const line of lines) {
      this.queue.ingestLine(line);
    }
  }

  /** Called by the command queue for every line that is not an ack
   * or error response for the currently pending command. */
  private handleLine(line: string): void {
    // Empty lines (just a CR or LF) parse to null; drop them.
    for (const cb of this.lineListeners) {
      try {
        cb(line);
      } catch (err) {
        this.log(`[8020 line listener] threw: ${(err as Error).message}`);
      }
    }
    const event = parseLine(line);
    if (event === null) return;
    this.banner.push(event);
    for (const cb of this.eventListeners) {
      try {
        cb(event);
      } catch (err) {
        this.log(`[8020 event listener] threw: ${(err as Error).message}`);
      }
    }
    if (event.kind === 'unknown') return;
    const next = reduce(this.state, event);
    if (next !== this.state) {
      this.state = next;
      for (const cb of this.stateListeners) {
        try {
          cb(next);
        } catch (err) {
          this.log(`[8020 state listener] threw: ${(err as Error).message}`);
        }
      }
    }
  }

  private setConnection(s: ConnectionState8020): void {
    if (this.connectionState === s) return;
    this.connectionState = s;
    for (const cb of this.connectionListeners) {
      try {
        cb(s);
      } catch (err) {
        this.log(`[8020 connection listener] threw: ${(err as Error).message}`);
      }
    }
  }
}
