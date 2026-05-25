/**
 * Byte-stream → line framer for the PortaCount 8020.
 *
 * The 8020 emits ASCII lines terminated by `\r`, `\n`, or `\r\n`
 * depending on origin (the device, fit-test runner output, and boot
 * banner are not consistent — the parser accepts any). This assembler
 * is the synchronous, table-driven counterpart to
 * {@link ResponseAssembler}: it accumulates bytes, slices off complete
 * lines as terminators appear, and buffers the rest.
 *
 * Holds no timers, emits no events. Empty lines are passed through
 * unchanged — the parser is responsible for filtering them.
 */

export class LineAssembler {
  /** Bytes accumulated for the current (unfinished) line. */
  private buffer: number[] = [];
  /** True if the last byte we saw was `\r` and we're waiting to see
   * whether the next byte is `\n` (so we can collapse `\r\n` into a
   * single terminator rather than emitting a spurious empty line). */
  private pendingCR = false;
  private decoder = new TextDecoder('utf-8', { fatal: false });

  /**
   * Feed `data` to the assembler. Returns zero or more complete lines
   * (terminator stripped). Lines are decoded as UTF-8; invalid bytes
   * are passed through using the replacement character.
   */
  push(data: Uint8Array): string[] {
    if (data.length === 0) return [];
    const out: string[] = [];
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (this.pendingCR) {
        this.pendingCR = false;
        if (b === 0x0a) {
          // Swallow the LF half of \r\n; the line was already emitted
          // when we saw \r.
          continue;
        }
        // fallthrough to handle b normally
      }
      if (b === 0x0d) {
        out.push(this.flush());
        this.pendingCR = true;
      } else if (b === 0x0a) {
        out.push(this.flush());
      } else {
        this.buffer.push(b);
      }
    }
    return out;
  }

  /** Return whatever is currently buffered (without a terminator) and
   * clear the buffer. Used at shutdown if you want to capture the
   * partial-final line. */
  takeBuffered(): string {
    return this.flush();
  }

  /** Number of buffered bytes for the current unfinished line. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Drop any accumulated bytes. Resets the `\r\n`-collapse state too. */
  reset(): void {
    this.buffer = [];
    this.pendingCR = false;
  }

  private flush(): string {
    if (this.buffer.length === 0) return '';
    const bytes = Uint8Array.from(this.buffer);
    this.buffer = [];
    return this.decoder.decode(bytes);
  }
}
