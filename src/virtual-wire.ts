import type { LwipStack } from './lwip-wasm';

/**
 * Connects two LwipStack instances at the Ethernet frame level.
 *
 * Frames output by Stack A are delivered to Stack B's input, and vice versa.
 * Delivery uses queueMicrotask to avoid lwIP reentrancy — lwIP cannot
 * process a new frame while a linkoutput callback is still on the stack.
 */
export class VirtualWire {
  private stackA: LwipStack | null = null;
  private stackB: LwipStack | null = null;
  private onFrame?: (from: 'A' | 'B', frame: Uint8Array) => void;

  /**
   * @param onFrame Optional observer called for every frame crossing the wire.
   *   Useful for logging/debugging in the webapp or assertions in tests.
   */
  constructor(onFrame?: (from: 'A' | 'B', frame: Uint8Array) => void) {
    this.onFrame = onFrame;
  }

  /**
   * Callback to pass as `onOutputFrame` when creating Stack A.
   * Delivers the frame to Stack B on the next microtask.
   */
  readonly handleFrameFromA = (frame: Uint8Array): void => {
    this.onFrame?.('A', frame);
    const b = this.stackB;
    if (b) {
      queueMicrotask(() => b.injectFrame(frame));
    }
  };

  /**
   * Callback to pass as `onOutputFrame` when creating Stack B.
   * Delivers the frame to Stack A on the next microtask.
   */
  readonly handleFrameFromB = (frame: Uint8Array): void => {
    this.onFrame?.('B', frame);
    const a = this.stackA;
    if (a) {
      queueMicrotask(() => a.injectFrame(frame));
    }
  };

  /** Register Stack A (typically the client/host side). */
  setStackA(stack: LwipStack): void {
    this.stackA = stack;
  }

  /** Register Stack B (typically the server/device side). */
  setStackB(stack: LwipStack): void {
    this.stackB = stack;
  }
}
