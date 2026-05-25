/**
 * ByteStream is a peer-level transport abstraction for byte-oriented
 * links — RS-232 over Web Serial, a future serial-over-BLE adapter,
 * or a WebSocket connection to the standalone simulator.
 *
 * It is intentionally *not* a generalization of {@link WireLayer} —
 * that interface is frame-oriented (Ethernet frames to/from lwIP) and
 * has no business carrying single-byte writes. The two interfaces are
 * peers, each with one job.
 *
 * Implementations own all transport state (open port handles, reader
 * loops, socket connections). They surface inbound data via the single
 * `onData` callback set by the caller; replacing the callback is
 * allowed and replaces all previous subscribers — there is no built-in
 * fan-out, because the 8020 client owns its own line assembler and
 * never wants more than one consumer.
 */
export interface ByteStream {
  /** Send a chunk of bytes to the device. Resolves when the bytes have
   * been handed to the underlying transport (not necessarily acked). */
  write(bytes: Uint8Array): Promise<void>;

  /** Register the single data callback. Calling again replaces the
   * previous callback. Passing `null` detaches without closing. */
  onData(cb: ((chunk: Uint8Array) => void) | null): void;

  /** Close the underlying transport and release all resources. Safe to
   * call repeatedly; subsequent calls are no-ops. After close, `write`
   * rejects. */
  close(): Promise<void>;

  /** Optional human-readable label for logging (e.g. "ttyUSB0 @ 1200",
   * "ws://localhost:18020"). */
  readonly info?: { label: string };
}
