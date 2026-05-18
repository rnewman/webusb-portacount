/**
 * Synchronous byte-stream → discrete-response framer for the Portacount
 * 8030 wire protocol.
 *
 * The protocol terminates each response with `\r\r` (two CR bytes, no LF).
 * We accumulate inbound TCP chunks until we see that terminator, at which
 * point the response is complete. Some response paths don't terminate
 * cleanly (port 3602 closes after sending the runtime int; a quiescence
 * window after the first byte may be the only completion signal). Those
 * cases are owned by the orchestration layer, which calls {@link takeBuffered}
 * when it decides "this is done".
 *
 * The assembler holds no timers and emits no events — it's a pure
 * accumulator. All async concerns (quiescence timers, exchange timeouts,
 * peer-close handling) live one layer up in `Portacount.exchange`.
 */

const TERMINATOR = new Uint8Array([0x0d, 0x0d]); // "\r\r"

export type AssemblerResult =
  | { kind: 'incomplete' }
  | { kind: 'complete'; bytes: Uint8Array };

export class ResponseAssembler {
  private chunks: Uint8Array[] = [];
  private length = 0;

  /**
   * Append a chunk. Returns `complete` (and resets internal state) if the
   * accumulated bytes contain the `\r\r` terminator, otherwise `incomplete`.
   *
   * The returned `bytes` includes the terminator and any trailing bytes
   * that arrived in the same chunk — callers that care about the difference
   * should trim explicitly, but in practice the device sends one response
   * per command and the bytes after `\r\r` are zero.
   */
  push(data: Uint8Array): AssemblerResult {
    if (data.length === 0) {
      return { kind: 'incomplete' };
    }
    this.chunks.push(data);
    this.length += data.length;
    const buf = this.snapshot();
    if (indexOfSubarray(buf, TERMINATOR) >= 0) {
      this.reset();
      return { kind: 'complete', bytes: buf };
    }
    return { kind: 'incomplete' };
  }

  /**
   * Return whatever is currently buffered and reset. Used by the
   * orchestration layer when a non-terminator completion signal fires
   * (quiescence elapses; peer closes the connection with bytes still
   * buffered).
   */
  takeBuffered(): Uint8Array {
    const buf = this.snapshot();
    this.reset();
    return buf;
  }

  /** Number of bytes accumulated since the last completion. */
  get pending(): number {
    return this.length;
  }

  /** Drop any accumulated bytes. */
  reset(): void {
    this.chunks = [];
    this.length = 0;
  }

  /**
   * Materialise the current chunks as a single Uint8Array. Cheap if
   * there's only one chunk (return it directly); allocates on multi-chunk.
   */
  private snapshot(): Uint8Array {
    if (this.chunks.length === 0) return new Uint8Array(0);
    if (this.chunks.length === 1) return this.chunks[0];
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const c of this.chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }
}

/**
 * Linear search for `needle` in `haystack`. Returns the byte offset of
 * the first match, or -1 if absent. Exported for tests and reuse.
 */
export function indexOfSubarray(haystack: Uint8Array, needle: Uint8Array): number {
  if (needle.length === 0) return 0;
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Trim trailing `\0` bytes. Device responses don't typically carry them
 * over TCP, but we trim defensively in case a buffered reader upstream
 * leaves padding behind.
 */
export function trimTrailingNulls(buf: Uint8Array): Uint8Array {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  return buf.subarray(0, end);
}
