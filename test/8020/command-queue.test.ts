import { describe, expect, it } from 'vitest';
import {
  CommandAbortedError,
  CommandError8020,
  CommandQueue8020,
  CommandTimeoutError,
} from '../../src/8020/command-queue';

const utf8 = new TextDecoder();
const decode = (b: Uint8Array) => utf8.decode(b);

interface Harness {
  queue: CommandQueue8020;
  writes: string[];
  unsolicited: string[];
  /** Reply to the queue, simulating bytes arriving from the device. */
  reply(line: string): void;
}

function makeHarness(opts: { writeRejects?: () => Error | null } = {}): Harness {
  const writes: string[] = [];
  const unsolicited: string[] = [];
  const queue = new CommandQueue8020({
    write: async (bytes) => {
      const err = opts.writeRejects?.();
      if (err) throw err;
      writes.push(decode(bytes));
    },
    onUnsolicitedLine: (line) => unsolicited.push(line),
  });
  return {
    queue,
    writes,
    unsolicited,
    reply: (line) => queue.ingestLine(line),
  };
}

describe('CommandQueue8020', () => {
  it('echo-ack: resolves when device echoes the command (and forwards ack to unsolicited)', async () => {
    const h = makeHarness();
    const p = h.queue.command('ZE');
    expect(h.writes).toEqual(['ZE\r']);
    h.reply('ZE');
    await expect(p).resolves.toBe('ZE');
    // Ack lines are forwarded so the client's state reducer can see them.
    expect(h.unsolicited).toEqual(['ZE']);
  });

  it("J's override ack: OK first, EJ subsequent", async () => {
    const h = makeHarness();
    const p1 = h.queue.command('J');
    h.reply('OK');
    await expect(p1).resolves.toBe('OK');
    const p2 = h.queue.command('J');
    h.reply('EJ');
    await expect(p2).resolves.toBe('EJ');
  });

  it('passes unsolicited lines through while a command is pending', async () => {
    const h = makeHarness();
    const p = h.queue.command('ZE');
    h.reply('006408.45');
    h.reply('006410.10');
    h.reply('ZE');
    await expect(p).resolves.toBe('ZE');
    expect(h.unsolicited).toEqual(['006408.45', '006410.10', 'ZE']);
  });

  it('rejects with CommandError8020 on E<cmd>', async () => {
    const h = makeHarness();
    const p = h.queue.command('ZE');
    h.reply('EZE');
    await expect(p).rejects.toBeInstanceOf(CommandError8020);
  });

  it('rejects with write-protected error on W<cmd>', async () => {
    const h = makeHarness();
    const p = h.queue.command('PTM0140');
    h.reply('WPTM0140');
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(CommandError8020);
    expect((err as CommandError8020).kind).toBe('write-protected');
  });

  it('does not consume an E<other> line as our error', async () => {
    const h = makeHarness();
    const p = h.queue.command('ZE');
    h.reply('EOTHER'); // an error reply for some other command? — pass through
    h.reply('ZE');
    await expect(p).resolves.toBe('ZE');
    expect(h.unsolicited).toEqual(['EOTHER', 'ZE']);
  });

  it('serializes concurrent commands', async () => {
    const h = makeHarness();
    const order: string[] = [];
    const p1 = h.queue.command('ZE').then((l) => order.push(`p1:${l}`));
    const p2 = h.queue.command('R').then((l) => order.push(`p2:${l}`));

    // After both .command() calls return, only the first should have
    // been written to the wire.
    await Promise.resolve();
    expect(h.writes).toEqual(['ZE\r']);

    h.reply('ZE');
    await p1;
    // Second command now writes.
    await Promise.resolve();
    expect(h.writes).toEqual(['ZE\r', 'R\r']);

    h.reply('RGG');
    await p2;
    expect(order).toEqual(['p1:ZE', 'p2:RGG']);
  });

  it('continues serving the queue after a rejection', async () => {
    const h = makeHarness();
    const p1 = h.queue.command('ZE');
    h.reply('EZE');
    await expect(p1).rejects.toBeInstanceOf(CommandError8020);

    const p2 = h.queue.command('ZD');
    await Promise.resolve();
    expect(h.writes).toEqual(['ZE\r', 'ZD\r']);
    h.reply('ZD');
    await expect(p2).resolves.toBe('ZD');
  });

  it('times out and rejects with CommandTimeoutError', async () => {
    const h = makeHarness();
    const p = h.queue.command('R', { timeoutMs: 25 });
    await expect(p).rejects.toBeInstanceOf(CommandTimeoutError);
    expect(h.unsolicited).toEqual([]);
  });

  it('honors AbortSignal pre-abort', async () => {
    const h = makeHarness();
    const ac = new AbortController();
    ac.abort(new Error('caller-aborted'));
    const p = h.queue.command('R', { signal: ac.signal });
    await expect(p).rejects.toBeInstanceOf(CommandAbortedError);
  });

  it('honors AbortSignal mid-flight', async () => {
    const h = makeHarness();
    const ac = new AbortController();
    const p = h.queue.command('R', { signal: ac.signal, timeoutMs: 1000 });
    // Let the write happen.
    await Promise.resolve();
    expect(h.writes).toEqual(['R\r']);
    ac.abort(new Error('caller-aborted'));
    await expect(p).rejects.toBeInstanceOf(CommandAbortedError);
  });

  it('rejects when write() fails', async () => {
    const h = makeHarness({ writeRejects: () => new Error('transport closed') });
    const p = h.queue.command('ZE');
    await expect(p).rejects.toThrow('transport closed');
  });

  it('close() rejects pending command and refuses new ones', async () => {
    const h = makeHarness();
    const p = h.queue.command('ZE');
    h.queue.close();
    await expect(p).rejects.toBeInstanceOf(CommandAbortedError);
    await expect(h.queue.command('ZD')).rejects.toBeInstanceOf(CommandAbortedError);
  });

  it('supports an explicit ackPattern override', async () => {
    const h = makeHarness();
    const p = h.queue.command('B01', { ackPattern: /^DONE$/ });
    h.reply('B01'); // echo should not satisfy because pattern is custom
    h.reply('DONE');
    await expect(p).resolves.toBe('DONE');
    expect(h.unsolicited).toEqual(['B01', 'DONE']);
  });

  it('multi-char commands with regex meta are escaped', async () => {
    const h = makeHarness();
    const p = h.queue.command('PPxxvvvvv'); // characters fine, but exercise default echo
    h.reply('PPxxvvvvv');
    await expect(p).resolves.toBe('PPxxvvvvv');
  });
});
