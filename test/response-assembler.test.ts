import { describe, expect, it } from 'vitest';
import { ResponseAssembler, indexOfSubarray, trimTrailingNulls } from '../src/response-assembler';

const utf8 = new TextEncoder();
const bytes = (...parts: string[]) => utf8.encode(parts.join(''));
const ascii = (b: Uint8Array) => new TextDecoder().decode(b);

describe('ResponseAssembler', () => {
  it('returns complete on a single chunk carrying the \\r\\r terminator', () => {
    const a = new ResponseAssembler();
    const r = a.push(bytes('hello\r\r'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('hello\r\r');
    expect(a.pending).toBe(0); // reset on complete
  });

  it('returns incomplete when the terminator has not arrived', () => {
    const a = new ResponseAssembler();
    expect(a.push(bytes('partial')).kind).toBe('incomplete');
    expect(a.pending).toBe(7);
  });

  it('accumulates across chunks and completes on the chunk carrying \\r\\r', () => {
    const a = new ResponseAssembler();
    expect(a.push(bytes('one ')).kind).toBe('incomplete');
    expect(a.push(bytes('two ')).kind).toBe('incomplete');
    const r = a.push(bytes('three\r\r'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('one two three\r\r');
  });

  it('detects a \\r\\r terminator split across chunks', () => {
    const a = new ResponseAssembler();
    expect(a.push(bytes('payload\r')).kind).toBe('incomplete');
    const r = a.push(bytes('\r'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('payload\r\r');
  });

  it('returns extra trailing bytes inside the same completing chunk', () => {
    // We don't artificially split — bytes after \r\r in the same chunk
    // become part of the "complete" payload. (In practice the device sends
    // one response per command, so this is a defensive case.)
    const a = new ResponseAssembler();
    const r = a.push(bytes('first\r\rEXTRA'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('first\r\rEXTRA');
  });

  it('is ready for a new exchange after a completion', () => {
    const a = new ResponseAssembler();
    a.push(bytes('A\r\r'));
    expect(a.pending).toBe(0);
    const r = a.push(bytes('B\r\r'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('B\r\r');
  });

  it('takeBuffered returns and clears accumulated bytes', () => {
    const a = new ResponseAssembler();
    a.push(bytes('999'));
    expect(a.pending).toBe(3);
    expect(ascii(a.takeBuffered())).toBe('999');
    expect(a.pending).toBe(0);
    // Subsequent takeBuffered with nothing buffered returns empty.
    expect(a.takeBuffered().length).toBe(0);
  });

  it('reset() drops anything buffered', () => {
    const a = new ResponseAssembler();
    a.push(bytes('garbage'));
    a.reset();
    expect(a.pending).toBe(0);
    expect(a.takeBuffered().length).toBe(0);
  });

  it('ignores empty pushes', () => {
    const a = new ResponseAssembler();
    expect(a.push(new Uint8Array(0)).kind).toBe('incomplete');
    expect(a.pending).toBe(0);
  });

  it('handles a single byte at a time', () => {
    const a = new ResponseAssembler();
    for (const c of 'abc') expect(a.push(bytes(c)).kind).toBe('incomplete');
    expect(a.push(bytes('\r')).kind).toBe('incomplete');
    const r = a.push(bytes('\r'));
    expect(r.kind).toBe('complete');
    if (r.kind === 'complete') expect(ascii(r.bytes)).toBe('abc\r\r');
  });

  it('handles a multi-chunk close-then-take flow (3602 closes after the int)', () => {
    // Port 3602 closes after sending the runtime int with no terminator;
    // the orchestrator above calls takeBuffered() on close.
    const a = new ResponseAssembler();
    a.push(bytes('123'));
    a.push(bytes('45'));
    expect(a.pending).toBe(5);
    expect(ascii(a.takeBuffered())).toBe('12345');
  });
});

describe('indexOfSubarray', () => {
  const hay = new Uint8Array([1, 2, 3, 13, 13, 4, 5, 13, 13]);

  it('returns 0 for an empty needle', () => {
    expect(indexOfSubarray(hay, new Uint8Array([]))).toBe(0);
  });

  it('finds a needle at the start', () => {
    expect(indexOfSubarray(hay, new Uint8Array([1, 2]))).toBe(0);
  });

  it('finds a needle in the middle', () => {
    expect(indexOfSubarray(hay, new Uint8Array([13, 13]))).toBe(3);
  });

  it('finds a needle at the end', () => {
    expect(indexOfSubarray(hay, new Uint8Array([5, 13, 13]))).toBe(6);
  });

  it('returns -1 when the needle does not appear', () => {
    expect(indexOfSubarray(hay, new Uint8Array([99]))).toBe(-1);
  });

  it('returns -1 when the needle is longer than the haystack', () => {
    expect(indexOfSubarray(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3]))).toBe(-1);
  });

  it('does not produce a false match across non-contiguous positions', () => {
    expect(indexOfSubarray(new Uint8Array([1, 2, 3]), new Uint8Array([1, 3]))).toBe(-1);
  });
});

describe('trimTrailingNulls', () => {
  it('returns the same view when there are no trailing nulls', () => {
    expect(Array.from(trimTrailingNulls(new Uint8Array([1, 2, 3])))).toEqual([1, 2, 3]);
  });

  it('strips trailing nulls', () => {
    expect(Array.from(trimTrailingNulls(new Uint8Array([1, 2, 0, 0, 0])))).toEqual([1, 2]);
  });

  it('returns an empty buffer when input is all nulls', () => {
    expect(trimTrailingNulls(new Uint8Array([0, 0, 0])).length).toBe(0);
  });

  it('handles an empty input', () => {
    expect(trimTrailingNulls(new Uint8Array([])).length).toBe(0);
  });

  it('preserves interior nulls', () => {
    expect(Array.from(trimTrailingNulls(new Uint8Array([1, 0, 2, 0, 0])))).toEqual([1, 0, 2]);
  });
});
