/**
 * Orchestration tests for Portacount: timers, state machine, promise
 * wiring around the TCP session. Pure framing (bytes → discrete response)
 * lives in test/response-assembler.test.ts; nothing here re-tests it.
 *
 * Tests synchronise on actual events via Channel<T> stubs, not on
 * microtask hops — adding awaits inside Portacount won't break these.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Cmd, Portacount } from '../src/portacount';
import type { IpOctets, LwipStack, TcpHandlers } from '../src/lwip-wasm';

/**
 * A buffered async channel: producers push, consumers await. Decouples
 * "event happened" from "test ready to observe it" — events that occur
 * before the test asks for them are queued.
 */
class Channel<T> {
  private queued: T[] = [];
  private waiters: Array<(value: T) => void> = [];

  push(value: T): void {
    const w = this.waiters.shift();
    if (w) w(value); else this.queued.push(value);
  }

  next(): Promise<T> {
    if (this.queued.length > 0) return Promise.resolve(this.queued.shift()!);
    return new Promise((r) => this.waiters.push(r));
  }
}

function makeStubStack() {
  let handlers: TcpHandlers = {};
  const writes: Uint8Array[] = [];
  let closes = 0;
  const writeCh = new Channel<Uint8Array>();
  const closeCh = new Channel<void>();
  const connectCh = new Channel<{ ip: IpOctets; port: number }>();

  const stack = {
    setTcpHandlers: (h: TcpHandlers) => { handlers = h; },
    tcpConnect: (ip: IpOctets, port: number) => { connectCh.push({ ip, port }); },
    tcpWrite: (data: Uint8Array) => {
      const copy = new Uint8Array(data);
      writes.push(copy);
      writeCh.push(copy);
    },
    tcpClose: () => { closes++; closeCh.push(undefined); },
  } as unknown as LwipStack;

  return {
    stack,
    get handlers() { return handlers; },
    writes,
    get closeCount() { return closes; },
    nextConnect: () => connectCh.next(),
    nextWrite: () => writeCh.next(),
    nextClose: () => closeCh.next(),
  };
}

const DEVICE_IP: IpOctets = [169, 254, 207, 137];
const utf8 = new TextEncoder();
const text = (...parts: string[]) => utf8.encode(parts.join(''));
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('Portacount: connect lifecycle', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('rejects on connect timeout (never fires onConnected)', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 1000);
    // Attach rejection-handler eagerly — the connect timer rejects
    // synchronously inside advanceTimersByTimeAsync.
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await stub.nextConnect();
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
  });

  it('rejects on TCP error during exchange', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 5000);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    stub.handlers.onError?.(-13);
    await expect(p).rejects.toThrow(/tcp error code=-13/);
  });

  it('rejects on exchange timeout, then finalises the close', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 500);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    await vi.advanceTimersByTimeAsync(501);
    await stub.nextClose();
    stub.handlers.onClosed?.();

    await expect(p).rejects.toThrow(/timeout after 500ms/);
  });

  it('exchange timeout tears down the connection — exactly once', async () => {
    // Regression for the late-bytes-leak-into-next-exchange hazard:
    // exchange timeout itself triggers closeTcp, and readRuntime's finally
    // also calls closeTcp. The cached closingPromise must make those
    // observe the same close — one tcpClose, one pendingClose timer.
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 500);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    await vi.advanceTimersByTimeAsync(501);
    await stub.nextClose();
    stub.handlers.onClosed?.();
    await expect(p).rejects.toThrow(/timeout/);

    expect(stub.closeCount).toBe(1);
  });

  it('resolves response via quiescence when no \\r\\r arrives', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 5000);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    stub.handlers.onData?.(text('999'));
    // 200ms quiescence window has to elapse for completion.
    await vi.advanceTimersByTimeAsync(199);
    // Not yet — we're not yet at the close stage. (Hard to assert from
    // outside; we just rely on the next advance triggering completion.)
    await vi.advanceTimersByTimeAsync(2);

    await stub.nextClose();
    stub.handlers.onClosed?.();
    expect(await p).toBe(999);
  });

  it('resolves on peer-close with buffered data (3602 closes after the int)', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 5000);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    stub.handlers.onData?.(text('7'));
    stub.handlers.onClosed?.();
    expect(await p).toBe(7);
  });

  it('rejects on peer-close with empty buffer', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 5000);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    stub.handlers.onClosed?.();
    await expect(p).rejects.toThrow(/closed before response/);
  });

  it('rejects on non-integer runtime response', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.readRuntime(DEVICE_IP, 5000);
    stub.handlers.onConnected?.();
    await stub.nextWrite();

    stub.handlers.onData?.(text('ERROR\r\r'));
    await stub.nextClose();
    stub.handlers.onClosed?.();

    await expect(p).rejects.toThrow(/non-integer response/);
  });
});

describe('Portacount: connect() handshake on port 3603', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('walks SYSTEM/ALL → FITPRO_STRING → LOCK READ (REMOTE branch) → UNIT_NUMBER', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.connect(DEVICE_IP, 1);
    expect((await stub.nextConnect()).port).toBe(3603);
    stub.handlers.onConnected?.();

    expect(dec(await stub.nextWrite())).toBe(Cmd.systemAll + '\r\r');
    stub.handlers.onData?.(text(
      '<MAIN><SYSTEM>',
      '<SERIAL_NUMBER>00023550</SERIAL_NUMBER>',
      '<MODEL_NUMBER>8030</MODEL_NUMBER>',
      '<BUILD_STRING>3.0.0</BUILD_STRING>',
      '</SYSTEM></MAIN>\r\r',
    ));

    expect(dec(await stub.nextWrite())).toBe(Cmd.fitProString('2.0.0.0') + '\r\r');
    stub.handlers.onData?.(text('<MAIN><SYSTEM><FITPRO_STRING>OK</FITPRO_STRING></SYSTEM></MAIN>\r\r'));

    expect(dec(await stub.nextWrite())).toBe(Cmd.lockRead + '\r\r');
    stub.handlers.onData?.(text('<MAIN><SYSTEM><LOCK>UNLOCK</LOCK></SYSTEM></MAIN>\r\r'));

    expect(dec(await stub.nextWrite())).toBe(Cmd.lockWriteRemote + '\r\r');
    stub.handlers.onData?.(text('<MAIN><SYSTEM><LOCK>REMOTE</LOCK></SYSTEM></MAIN>\r\r'));

    expect(dec(await stub.nextWrite())).toBe(Cmd.unitNumberWrite(1) + '\r\r');
    stub.handlers.onData?.(text('<MAIN><SYSTEM><UNIT_NUMBER>1</UNIT_NUMBER></SYSTEM></MAIN>\r\r'));

    expect(await p).toEqual({
      serialNumber: '00023550',
      modelNumber: '8030',
      buildString: '3.0.0',
    });
  });

  it('skips the LOCK WRITE step when the device is already locked elsewhere', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.connect(DEVICE_IP, 1);
    stub.handlers.onConnected?.();

    await stub.nextWrite(); // SYSTEM/ALL
    stub.handlers.onData?.(text(
      '<MAIN><SYSTEM><SERIAL_NUMBER>x</SERIAL_NUMBER>',
      '<MODEL_NUMBER>8030</MODEL_NUMBER>',
      '<BUILD_STRING>z</BUILD_STRING></SYSTEM></MAIN>\r\r',
    ));
    await stub.nextWrite(); // FITPRO_STRING
    stub.handlers.onData?.(text('<MAIN/>\r\r'));
    await stub.nextWrite(); // LOCK READ
    stub.handlers.onData?.(text('<MAIN><SYSTEM><LOCK>REMOTE</LOCK></SYSTEM></MAIN>\r\r'));

    // Next write should be UNIT_NUMBER, not LOCK WRITE.
    expect(dec(await stub.nextWrite())).toBe(Cmd.unitNumberWrite(1) + '\r\r');
    stub.handlers.onData?.(text('<MAIN/>\r\r'));

    await expect(p).resolves.toMatchObject({ serialNumber: 'x', modelNumber: '8030' });
  });

  it('rejects if SYSTEM/ALL reply does not include SERIAL_NUMBER', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const p = pc.connect(DEVICE_IP, 1);
    stub.handlers.onConnected?.();

    await stub.nextWrite();
    stub.handlers.onData?.(text('<MAIN><SYSTEM><ERROR>nope</ERROR></SYSTEM></MAIN>\r\r'));
    await stub.nextClose();
    stub.handlers.onClosed?.();

    await expect(p).rejects.toThrow(/SYSTEM\/ALL reply missing SERIAL_NUMBER/);
  });
});

describe('Portacount: re-entry protection', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('rejects a second open while another flow is in flight', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);

    const first = pc.readRuntime(DEVICE_IP, 5000);
    await stub.nextConnect();
    await expect(pc.readRuntime(DEVICE_IP, 5000)).rejects.toThrow(/bad state/);

    // Tidy up the first.
    stub.handlers.onConnected?.();
    await stub.nextWrite();
    stub.handlers.onData?.(text('1\r\r'));
    await stub.nextClose();
    stub.handlers.onClosed?.();
    expect(await first).toBe(1);
  });

  it('command() rejects when state is not connected', async () => {
    const stub = makeStubStack();
    const pc = new Portacount(stub.stack);
    await expect(pc.command('<MAIN/>', 1000)).rejects.toThrow(/not connected/);
  });
});
