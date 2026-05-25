/**
 * Command queue for the PortaCount 8020 serial protocol.
 *
 * The 8020 acknowledges most commands by echoing the command bytes
 * verbatim on the next inbound line. A few commands have override
 * acknowledgments (the `J` external-control toggle replies `OK` or
 * `EJ` rather than echoing). Errors come back as `E<command>` and
 * write-protect refusals as `W<command>`.
 *
 * Commands are serialized: only one is outstanding at a time, and a
 * new caller's command waits for the prior one to settle. The first
 * command in an idle queue is dispatched synchronously from
 * {@link CommandQueue8020.command} — so a caller can `command(cmd)`
 * and then synchronously inspect the wire output. Subsequent ones
 * wait in a FIFO until the prior settles.
 *
 * Lines that arrive while a command is pending but do not match the
 * expected ack (or its error/write-protect variants) are passed
 * through to the unsolicited-line handler. This is essential: when
 * `ZE` is active the device streams concentrations continuously, and
 * those readings must not be consumed as acks.
 */

import { COMMAND_ACK_OVERRIDES } from './patterns';

const utf8 = new TextEncoder();

/** Default per-command timeout. The TSI Technical Addendum recommends
 * 3 s per attempt; we double that to be conservative since serial
 * round-trips on a 1200 bps link can be slow. */
const DEFAULT_TIMEOUT_MS = 6000;

export class CommandError8020 extends Error {
  constructor(
    readonly line: string,
    readonly command: string,
    readonly kind: 'error' | 'write-protected',
  ) {
    super(`${kind === 'error' ? 'Device error' : 'Write-protected'} for '${command}': ${line}`);
    this.name = 'CommandError8020';
  }
}

export class CommandTimeoutError extends Error {
  constructor(readonly command: string, readonly timeoutMs: number) {
    super(`Command '${command}' timed out after ${timeoutMs} ms`);
    this.name = 'CommandTimeoutError';
  }
}

export class CommandAbortedError extends Error {
  constructor(readonly command: string, cause?: unknown) {
    super(`Command '${command}' aborted${cause instanceof Error ? `: ${cause.message}` : ''}`);
    this.name = 'CommandAbortedError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export interface CommandOptions {
  /** Per-command timeout in milliseconds. Defaults to 6000. */
  timeoutMs?: number;
  /** Override the ack pattern. When absent, the queue uses the
   * command-specific override from {@link COMMAND_ACK_OVERRIDES}, or
   * falls back to "an exact echo of the command bytes". */
  ackPattern?: RegExp;
  /** Abort the command before it settles. Once aborted, the slot is
   * released and the next queued command can proceed; whatever bytes
   * the device sends in response (late ack) are passed through as
   * unsolicited lines. */
  signal?: AbortSignal;
}

interface PendingCommand {
  cmd: string;
  ackPattern: RegExp;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout> | null;
  signal?: AbortSignal;
  onSignalAbort?: () => void;
}

interface QueuedCommand {
  cmd: string;
  opts: CommandOptions;
  resolve: (line: string) => void;
  reject: (err: Error) => void;
}

export interface CommandQueueDeps {
  /** Send bytes to the device transport. */
  write: (bytes: Uint8Array) => Promise<void>;
  /** Called with every inbound line that is not consumed as an ack
   * or an error response for the currently pending command. */
  onUnsolicitedLine: (line: string) => void;
  /** Optional structured logging hook. */
  log?: (msg: string) => void;
}

export class CommandQueue8020 {
  private pending: PendingCommand | null = null;
  private waiting: QueuedCommand[] = [];
  private closed = false;

  constructor(private deps: CommandQueueDeps) {}

  /** Feed an inbound line to the queue. If a command is pending and
   * the line is its ack (or error / write-protected refusal), the
   * command settles.
   *
   * Ack lines are *also* delivered to
   * {@link CommandQueueDeps.onUnsolicitedLine} after resolving — the
   * ack itself often carries device-state information (e.g. `OK`
   * tells us we're now in external control; `RGG` carries battery /
   * pulse flags). Both the command's caller and the state reducer
   * want to see it.
   *
   * Error and write-protect lines are *not* forwarded — they carry
   * no state information beyond "your command failed". */
  ingestLine(line: string): void {
    if (this.pending) {
      const p = this.pending;
      if (p.ackPattern.test(line)) {
        this.settlePending();
        p.resolve(line);
        this.deps.onUnsolicitedLine(line);
        this.drain();
        return;
      }
      const errMatch = /^E(.+)$/.exec(line);
      if (errMatch && errMatch[1] === p.cmd) {
        this.settlePending();
        p.reject(new CommandError8020(line, p.cmd, 'error'));
        this.drain();
        return;
      }
      const wpMatch = /^W(.+)$/.exec(line);
      if (wpMatch && wpMatch[1] === p.cmd) {
        this.settlePending();
        p.reject(new CommandError8020(line, p.cmd, 'write-protected'));
        this.drain();
        return;
      }
    }
    this.deps.onUnsolicitedLine(line);
  }

  /** Send a command and resolve when the device acknowledges it. The
   * returned line is the ack line itself — callers usually ignore it
   * but it's available for diagnostics. */
  command(cmd: string, opts: CommandOptions = {}): Promise<string> {
    if (this.closed) {
      return Promise.reject(new CommandAbortedError(cmd, new Error('queue closed')));
    }
    if (cmd.length === 0) {
      return Promise.reject(new Error('command(): empty command'));
    }
    return new Promise<string>((resolve, reject) => {
      if (this.pending !== null) {
        this.waiting.push({ cmd, opts, resolve, reject });
        return;
      }
      this.startCommand(cmd, opts, resolve, reject);
    });
  }

  /** Reject all in-flight and queued commands, refuse new ones, and
   * release any pending timers. Safe to call repeatedly. */
  close(reason: Error = new Error('queue closed')): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const p = this.pending;
      this.settlePending();
      p.reject(new CommandAbortedError(p.cmd, reason));
    }
    const waiting = this.waiting;
    this.waiting = [];
    for (const q of waiting) {
      q.reject(new CommandAbortedError(q.cmd, reason));
    }
  }

  /** True if the queue has been closed and will accept no further
   * commands. */
  get isClosed(): boolean {
    return this.closed;
  }

  private startCommand(
    cmd: string,
    opts: CommandOptions,
    resolve: (line: string) => void,
    reject: (err: Error) => void,
  ): void {
    if (this.closed) {
      reject(new CommandAbortedError(cmd, new Error('queue closed')));
      return;
    }
    const signal = opts.signal;
    if (signal?.aborted) {
      reject(new CommandAbortedError(cmd, signal.reason));
      this.drain();
      return;
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const ackPattern =
      opts.ackPattern ?? COMMAND_ACK_OVERRIDES[cmd] ?? buildEchoAck(cmd);

    const onSignalAbort = () => {
      if (this.pending === entry) {
        this.settlePending();
        reject(new CommandAbortedError(cmd, signal!.reason));
        this.drain();
      }
    };

    const timeoutHandle = setTimeout(() => {
      if (this.pending === entry) {
        this.settlePending();
        reject(new CommandTimeoutError(cmd, timeoutMs));
        this.drain();
      }
    }, timeoutMs);

    const entry: PendingCommand = {
      cmd,
      ackPattern,
      resolve,
      reject,
      timeoutHandle,
      signal,
      onSignalAbort: signal ? onSignalAbort : undefined,
    };
    this.pending = entry;
    signal?.addEventListener('abort', onSignalAbort, { once: true });

    this.deps.log?.(`[8020 tx] ${cmd}`);
    this.deps.write(utf8.encode(cmd + '\r')).catch((err: unknown) => {
      if (this.pending === entry) {
        this.settlePending();
        reject(err instanceof Error ? err : new Error(String(err)));
        this.drain();
      }
    });
  }

  private settlePending(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (p.timeoutHandle) clearTimeout(p.timeoutHandle);
    if (p.signal && p.onSignalAbort) {
      p.signal.removeEventListener('abort', p.onSignalAbort);
    }
  }

  private drain(): void {
    if (this.pending !== null) return;
    if (this.closed) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.startCommand(next.cmd, next.opts, next.resolve, next.reject);
  }
}

function buildEchoAck(cmd: string): RegExp {
  return new RegExp('^' + escapeRegex(cmd) + '$');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
