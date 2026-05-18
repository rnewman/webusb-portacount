/**
 * WireLayer defines the interface between USB framing (CDC-ECM/RNDIS)
 * and the lwIP Wasm network stack.
 *
 * Implementations handle the USB-specific framing and present raw
 * Ethernet frames to/from the network stack.
 */
export interface WireLayer {
  /** Wrap and send a raw Ethernet frame via the USB device. */
  sendFrame(frame: Uint8Array): Promise<void>;

  /**
   * Start receiving frames from the USB device. Each received frame
   * (after removing CDC-ECM/RNDIS framing) is passed to the callback.
   */
  startReceiving(onFrame: (frame: Uint8Array) => void): Promise<void>;

  /** Stop receiving frames. */
  stopReceiving(): Promise<void>;

  /** The MAC address of the USB network adapter (6 bytes). */
  readonly macAddress: Uint8Array;
}
