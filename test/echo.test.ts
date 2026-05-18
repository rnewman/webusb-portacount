import { describe, it, expect } from 'vitest';
import { LwipStack } from '../src/lwip-wasm';
import { VirtualWire } from '../src/virtual-wire';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmUrl = path.resolve(__dirname, '../build/lwip.js');

const MAC_A = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
const MAC_B = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x02]);
const IP_A: [number, number, number, number] = [169, 254, 1, 1];
const IP_B: [number, number, number, number] = [169, 254, 1, 2];
const NETMASK: [number, number, number, number] = [255, 255, 0, 0];
const ECHO_PORT = 7;

/**
 * Wait for a condition to be true, driving lwIP timeouts in the meantime.
 * Returns when the condition is met or throws after timeout.
 */
function waitFor(
  condition: () => boolean,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (condition()) {
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
      } else {
        setTimeout(check, intervalMs);
      }
    };
    check();
  });
}

describe('TCP echo test via virtual wire', () => {
  it('sends ping and receives echo', async () => {
    const wire = new VirtualWire();
    const received: Uint8Array[] = [];
    let connected = false;
    let closed = false;

    // Create Stack B (echo server)
    const stackB = await LwipStack.create(
      wasmUrl,
      MAC_B,
      wire.handleFrameFromB,
      { ip: IP_B, netmask: NETMASK },
    );
    wire.setStackB(stackB);
    stackB.startEchoServer(ECHO_PORT);

    // Create Stack A (client)
    const stackA = await LwipStack.create(
      wasmUrl,
      MAC_A,
      wire.handleFrameFromA,
      {
        ip: IP_A,
        netmask: NETMASK,
      },
    );
    stackA.setTcpHandlers({
      onConnected: () => { connected = true; },
      onData: (data: Uint8Array) => { received.push(data); },
      onClosed: () => { closed = true; },
    });
    wire.setStackA(stackA);

    try {
      // Connect A → B
      stackA.tcpConnect(IP_B, ECHO_PORT);

      // Wait for TCP connection (ARP + 3-way handshake)
      await waitFor(() => connected);
      expect(connected).toBe(true);

      // Send "ping"
      const encoder = new TextEncoder();
      stackA.tcpWrite(encoder.encode('ping'));

      // Wait for echo
      await waitFor(() => received.length > 0);

      const decoder = new TextDecoder();
      expect(decoder.decode(received[0])).toBe('ping');

      // Send "hello world"
      stackA.tcpWrite(encoder.encode('hello world'));
      await waitFor(() => received.length > 1);
      expect(decoder.decode(received[1])).toBe('hello world');

      // Close
      stackA.tcpClose();
    } finally {
      stackA.destroy();
      stackB.destroy();
    }
  });
});
