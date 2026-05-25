import { describe, expect, it } from 'vitest';
import { LineAssembler } from '../../src/8020/line-assembler';

const utf8 = new TextEncoder();
const bytes = (s: string) => utf8.encode(s);

describe('LineAssembler', () => {
  it('returns no lines until a terminator arrives', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('hello'))).toEqual([]);
    expect(a.pending).toBe(5);
  });

  it('emits a line on \\r', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('hello\r'))).toEqual(['hello']);
    expect(a.pending).toBe(0);
  });

  it('emits a line on \\n', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('hello\n'))).toEqual(['hello']);
    expect(a.pending).toBe(0);
  });

  it('collapses \\r\\n into a single terminator', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('hello\r\nworld\r\n'))).toEqual(['hello', 'world']);
  });

  it('collapses \\r\\n when split across chunks', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('hello\r'))).toEqual(['hello']);
    // The lone \n that follows should be swallowed, not emit "".
    expect(a.push(bytes('\nworld\r'))).toEqual(['world']);
  });

  it('does not collapse \\n\\r (treats as two terminators)', () => {
    const a = new LineAssembler();
    // \n ends "a"; then \r ends an empty line.
    expect(a.push(bytes('a\n\rb\r'))).toEqual(['a', '', 'b']);
  });

  it('emits multiple lines from one chunk', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('one\rtwo\rthree\r'))).toEqual(['one', 'two', 'three']);
  });

  it('preserves an unterminated trailing line in the buffer', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('done\rpartial'))).toEqual(['done']);
    expect(a.pending).toBe(7);
    expect(a.push(bytes('-rest\r'))).toEqual(['partial-rest']);
  });

  it('emits empty lines for back-to-back terminators', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('a\r\rb\r'))).toEqual(['a', '', 'b']);
  });

  it('handles one byte at a time', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('a'))).toEqual([]);
    expect(a.push(bytes('b'))).toEqual([]);
    expect(a.push(bytes('\r'))).toEqual(['ab']);
    expect(a.push(bytes('\n'))).toEqual([]); // \r\n collapse: swallow
    expect(a.push(bytes('c'))).toEqual([]);
    expect(a.push(bytes('\n'))).toEqual(['c']);
  });

  it('ignores empty pushes', () => {
    const a = new LineAssembler();
    expect(a.push(new Uint8Array(0))).toEqual([]);
    expect(a.pending).toBe(0);
  });

  it('takeBuffered returns and clears the unfinished line', () => {
    const a = new LineAssembler();
    a.push(bytes('half'));
    expect(a.takeBuffered()).toBe('half');
    expect(a.pending).toBe(0);
    expect(a.takeBuffered()).toBe('');
  });

  it('reset() drops anything buffered', () => {
    const a = new LineAssembler();
    a.push(bytes('garbage'));
    a.reset();
    expect(a.pending).toBe(0);
  });

  it('reset() also clears pendingCR so a stray \\n becomes empty line', () => {
    const a = new LineAssembler();
    a.push(bytes('x\r'));
    a.reset();
    // After reset, a lone \n is a terminator for an empty line.
    expect(a.push(bytes('\n'))).toEqual(['']);
  });

  it('decodes UTF-8 bytes', () => {
    const a = new LineAssembler();
    expect(a.push(bytes('café\r'))).toEqual(['café']);
  });

  it('parses a realistic concentration burst', () => {
    const a = new LineAssembler();
    const lines = a.push(bytes('006408.45\r000000.12\r'));
    expect(lines).toEqual(['006408.45', '000000.12']);
  });

  it('parses a realistic internal-mode burst', () => {
    const a = new LineAssembler();
    const lines = a.push(
      bytes('Conc.      0.00 #/cc\r\nConc.     10200 #/cc\r\nAmbient   2290 #/cc\r\n'),
    );
    expect(lines).toEqual([
      'Conc.      0.00 #/cc',
      'Conc.     10200 #/cc',
      'Ambient   2290 #/cc',
    ]);
  });
});
