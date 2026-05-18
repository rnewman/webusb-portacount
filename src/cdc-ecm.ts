import type { WireLayer } from './wire-layer';

/**
 * CDC-ECM (Ethernet Control Model) USB framing.
 *
 * CDC-ECM sends/receives Ethernet frames directly on bulk endpoints,
 * optionally with ZLP (zero-length packet) termination.
 *
 * STUB: not yet implemented.
 */
export class CdcEcmWireLayer implements WireLayer {
  readonly macAddress: Uint8Array;

  constructor(_device: USBDevice) {
    // TODO: read MAC from CDC-ECM Ethernet Networking functional descriptor
    this.macAddress = new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]);
  }

  async sendFrame(_frame: Uint8Array): Promise<void> {
    throw new Error('CdcEcmWireLayer.sendFrame not implemented');
  }

  async startReceiving(_onFrame: (frame: Uint8Array) => void): Promise<void> {
    throw new Error('CdcEcmWireLayer.startReceiving not implemented');
  }

  async stopReceiving(): Promise<void> {
    throw new Error('CdcEcmWireLayer.stopReceiving not implemented');
  }
}
