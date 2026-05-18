import type { WireLayer } from './wire-layer';
import {
  CDC_REQ_GET_ENCAPSULATED_RESPONSE,
  CDC_REQ_SEND_ENCAPSULATED_COMMAND,
  NDIS_PACKET_TYPE_BROADCAST,
  NDIS_PACKET_TYPE_DIRECTED,
  NDIS_PACKET_TYPE_MULTICAST,
  OID_GEN_CURRENT_PACKET_FILTER,
  RNDIS_MAX_CONTROL_MESSAGE,
  RNDIS_PACKET_MSG,
  RNDIS_STATUS_SUCCESS,
  decodeInitializeCmplt,
  decodeSetCmplt,
  encodeInitializeMsg,
  encodePacketMsg,
  encodeSetU32Msg,
  extractPacketPayload,
  iterateMessages,
} from './rndis-protocol';

const PORTACOUNT_VENDOR_ID = 0x0894;
const PORTACOUNT_PRODUCT_ID = 0x0010;

/** Microsoft's class/subclass/protocol triple for an RNDIS comm interface. */
const RNDIS_COMM_CLASS = 0x02;
const RNDIS_COMM_SUBCLASS = 0x02;
const RNDIS_COMM_PROTOCOL = 0xff;

/** Standard CDC data interface (used by RNDIS devices for bulk data). */
const CDC_DATA_CLASS = 0x0a;

/** Default packet filter: receive frames addressed to us, plus broadcast & all-multicast. */
const DEFAULT_PACKET_FILTER =
  NDIS_PACKET_TYPE_DIRECTED |
  NDIS_PACKET_TYPE_BROADCAST |
  NDIS_PACKET_TYPE_MULTICAST;

export interface RndisOpenOptions {
  /** Override the packet filter bitmap. Default: DIRECTED|BROADCAST|MULTICAST. */
  packetFilter?: number;
  /** Logger for protocol-level events. Useful for protocol-level debugging. */
  log?: (msg: string) => void;
}

/** Diagnostic info captured during RNDIS init — surfaced for the probe script and journal. */
export interface RndisDeviceInfo {
  macAddress: Uint8Array;
  maxTransferSize: number;
  maxPacketsPerTransfer: number;
  packetAlignment: number;
}

interface Endpoints {
  controlInterface: number;
  dataInterface: number;
  interruptIn: number;
  interruptInPacketSize: number;
  bulkIn: number;
  bulkOut: number;
  bulkInPacketSize: number;
}


/**
 * RNDIS (Remote NDIS) USB wire layer.
 *
 * Initialises the device via the CDC control endpoint, then carries Ethernet
 * frames over the CDC data bulk endpoints wrapped in REMOTE_NDIS_PACKET_MSG.
 *
 * Construct via the {@link open} factory; the constructor is private because
 * setup requires multiple async USB exchanges.
 */
export class RndisWireLayer implements WireLayer {
  readonly macAddress: Uint8Array;
  readonly info: RndisDeviceInfo;

  private device: USBDevice;
  private endpoints: Endpoints;
  private log: (msg: string) => void;
  private nextRequestId = 1;
  private receiving = false;
  private receiveLoop: Promise<void> | null = null;
  private bulkInReadCount = 0;

  private constructor(
    device: USBDevice,
    endpoints: Endpoints,
    info: RndisDeviceInfo,
    log: (msg: string) => void,
  ) {
    this.device = device;
    this.endpoints = endpoints;
    this.info = info;
    this.macAddress = info.macAddress;
    this.log = log;
  }

  /**
   * Filter accepting any Portacount 8030 — both `WebUSB.requestDevice` (browser)
   * and `usb` package's `WebUSB({allowedDevices: [...]})` (Node) use the same shape.
   */
  static readonly USB_FILTER: USBDeviceFilter = {
    vendorId: PORTACOUNT_VENDOR_ID,
    productId: PORTACOUNT_PRODUCT_ID,
  };

  /**
   * Open the device, claim interfaces, run the RNDIS handshake, and return a
   * ready-to-use wire layer.
   *
   * @param device A W3C USBDevice (browser) or node-usb WebUSBDevice shim.
   */
  static async open(device: USBDevice, options: RndisOpenOptions = {}): Promise<RndisWireLayer> {
    const log = options.log ?? (() => {});

    if (!device.opened) {
      await device.open();
    }
    if (device.configuration === null) {
      await device.selectConfiguration(1);
    }

    const endpoints = findRndisEndpoints(device);
    log(
      `endpoints: control_intf=${endpoints.controlInterface} data_intf=${endpoints.dataInterface} ` +
      `interrupt_in=0x${endpoints.interruptIn.toString(16)} ` +
      `bulk_in=0x${endpoints.bulkIn.toString(16)} bulk_out=0x${endpoints.bulkOut.toString(16)} ` +
      `bulk_pkt=${endpoints.bulkInPacketSize}`,
    );

    await device.claimInterface(endpoints.controlInterface);
    await device.claimInterface(endpoints.dataInterface);
    log(`claimed interfaces ${endpoints.controlInterface}, ${endpoints.dataInterface}`);

    // ---- INITIALIZE ----
    const initReqId = 1;
    const initResp = await sendControlMessage(
      device,
      endpoints,
      encodeInitializeMsg(initReqId),
      log,
    );
    const init = decodeInitializeCmplt(initResp);
    if (init.status !== RNDIS_STATUS_SUCCESS) {
      throw new Error(`RNDIS init failed: status=0x${init.status.toString(16)}`);
    }
    log(
      `init ok: version=${init.majorVersion}.${init.minorVersion} ` +
      `medium=${init.medium} max_xfer=${init.maxTransferSize} ` +
      `max_pkts=${init.maxPacketsPerTransfer} align=${init.packetAlignmentFactor}`,
    );

    // ---- SET packet filter (enables RX) ----
    // The Portacount 8030's RNDIS firmware rejects every QUERY message with
    // status 0xc0010014, so we skip QUERY entirely. The MAC we publish is a
    // locally-administered placeholder; the device's actual MAC will surface
    // in its ARP/Ethernet replies once we start sending frames.
    const filter = options.packetFilter ?? DEFAULT_PACKET_FILTER;
    const setResp = await sendControlMessage(
      device,
      endpoints,
      encodeSetU32Msg(2, OID_GEN_CURRENT_PACKET_FILTER, filter),
      log,
    );
    const set = decodeSetCmplt(setResp);
    if (set.status !== RNDIS_STATUS_SUCCESS) {
      throw new Error(`SET packet filter failed: status=0x${set.status.toString(16)}`);
    }
    log(`packet filter set to 0x${filter.toString(16)}`);

    const info: RndisDeviceInfo = {
      macAddress: new Uint8Array([0x02, 0x00, 0x00, 0x00, 0x00, 0x01]),
      maxTransferSize: init.maxTransferSize,
      maxPacketsPerTransfer: init.maxPacketsPerTransfer,
      packetAlignment: 1 << init.packetAlignmentFactor,
    };

    const layer = new RndisWireLayer(device, endpoints, info, log);
    layer.nextRequestId = 3;
    return layer;
  }

  async sendFrame(frame: Uint8Array): Promise<void> {
    const msg = encodePacketMsg(frame);
    // Copy into a fresh ArrayBuffer to give WebUSB an unambiguous BufferSource
    // (a Uint8Array view's underlying buffer is typed ArrayBufferLike).
    const buf = new ArrayBuffer(msg.byteLength);
    new Uint8Array(buf).set(msg);
    const result = await this.device.transferOut(this.endpoints.bulkOut, buf);
    if (result.status !== 'ok') {
      throw new Error(`bulk-OUT transfer status: ${result.status}`);
    }
  }

  async startReceiving(onFrame: (frame: Uint8Array) => void): Promise<void> {
    if (this.receiving) return;
    this.receiving = true;
    const ep = this.endpoints.bulkIn;
    // Ask for the negotiated max transfer size each read; the device may pack
    // multiple PACKET_MSGs into a single transfer.
    const readLen = Math.max(this.info.maxTransferSize, 16 * 1024);

    this.receiveLoop = (async () => {
      while (this.receiving) {
        let result: USBInTransferResult;
        try {
          result = await this.device.transferIn(ep, readLen);
        } catch (err) {
          if (this.receiving) this.log(`bulk-IN read error: ${(err as Error).message}`);
          return;
        }
        if (!this.receiving) return;
        if (result.status === 'stall') {
          this.log('bulk-IN stalled; clearing halt');
          try {
            await this.device.clearHalt('in', ep);
          } catch (err) {
            this.log(`clearHalt failed: ${(err as Error).message}`);
          }
          continue;
        }
        if (result.status !== 'ok' || !result.data || result.data.byteLength === 0) {
          continue;
        }
        const view = new Uint8Array(
          result.data.buffer,
          result.data.byteOffset,
          result.data.byteLength,
        );
        let msgCount = 0;
        for (const msg of iterateMessages(view)) {
          msgCount++;
          const type = new DataView(msg.buffer, msg.byteOffset, msg.byteLength).getUint32(0, true);
          if (type === RNDIS_PACKET_MSG) {
            const payload = extractPacketPayload(msg);
            // Copy out: the underlying ArrayBuffer is reused on the next transferIn.
            onFrame(new Uint8Array(payload));
          } else {
            this.log(`unexpected RNDIS message type on bulk-IN: 0x${type.toString(16)}`);
          }
        }
        this.bulkInReadCount++;
        if (this.bulkInReadCount <= 3 || this.bulkInReadCount % 500 === 0) {
          this.log(`bulk-IN read #${this.bulkInReadCount}: ${view.byteLength}B → ${msgCount} msg(s)`);
        }
      }
    })();
  }

  async stopReceiving(): Promise<void> {
    this.receiving = false;
    if (this.receiveLoop) {
      // Cancel the in-flight transferIn by clearing the halt — node-usb honours this
      // and the loop exits on the resulting error. In the browser, the in-flight
      // transfer will resolve eventually; we just stop processing.
      try {
        await this.device.clearHalt('in', this.endpoints.bulkIn);
      } catch {
        // Ignore — best-effort cancellation.
      }
      await this.receiveLoop.catch(() => {});
      this.receiveLoop = null;
    }
  }

  /**
   * Release interfaces and close the device. Safe to call repeatedly.
   *
   * We do NOT send `REMOTE_NDIS_HALT_MSG` here even though the spec
   * suggests it as the clean "I'm leaving" message. Empirically the
   * Portacount 8030's firmware tolerates HALT for immediate
   * Disconnect→Connect cycles, but if the device sits idle for a few
   * minutes afterwards the *entire* device wedges — touchscreen
   * unresponsive, requires pulling the PSU to recover. That's strictly
   * worse than the prior failure mode (re-INIT hangs after a clean
   * disconnect, fixable by a USB cable unplug-replug). Keeping the
   * encoder in `rndis-protocol.ts` for future experimentation.
   */
  async close(): Promise<void> {
    await this.stopReceiving();
    try {
      await this.device.releaseInterface(this.endpoints.dataInterface);
    } catch {
      // ignore
    }
    try {
      await this.device.releaseInterface(this.endpoints.controlInterface);
    } catch {
      // ignore
    }
    try {
      await this.device.close();
    } catch {
      // ignore
    }
  }
}

// ---------- Helpers ----------

function findRndisEndpoints(device: USBDevice): Endpoints {
  const cfg = device.configuration;
  if (!cfg) throw new Error('device has no selected configuration');

  let commIntf: USBInterface | undefined;
  let dataIntf: USBInterface | undefined;

  for (const intf of cfg.interfaces) {
    const alt = intf.alternate;
    if (
      alt.interfaceClass === RNDIS_COMM_CLASS &&
      alt.interfaceSubclass === RNDIS_COMM_SUBCLASS &&
      alt.interfaceProtocol === RNDIS_COMM_PROTOCOL
    ) {
      commIntf = intf;
    } else if (alt.interfaceClass === CDC_DATA_CLASS) {
      dataIntf = intf;
    }
  }

  if (!commIntf) {
    throw new Error('No RNDIS communications interface (class 02/02/ff) on device');
  }
  if (!dataIntf) {
    throw new Error('No CDC data interface (class 0a) on device');
  }

  const interruptEp = commIntf.alternate.endpoints.find(
    (e) => e.type === 'interrupt' && e.direction === 'in',
  );
  if (!interruptEp) throw new Error('No interrupt-IN endpoint on RNDIS comm interface');

  const bulkIn = dataIntf.alternate.endpoints.find(
    (e) => e.type === 'bulk' && e.direction === 'in',
  );
  const bulkOut = dataIntf.alternate.endpoints.find(
    (e) => e.type === 'bulk' && e.direction === 'out',
  );
  if (!bulkIn || !bulkOut) throw new Error('Missing bulk endpoint(s) on CDC data interface');

  return {
    controlInterface: commIntf.interfaceNumber,
    dataInterface: dataIntf.interfaceNumber,
    interruptIn: interruptEp.endpointNumber,
    interruptInPacketSize: interruptEp.packetSize,
    bulkIn: bulkIn.endpointNumber,
    bulkOut: bulkOut.endpointNumber,
    bulkInPacketSize: bulkIn.packetSize,
  };
}

/**
 * Send an RNDIS control message and wait for the matching completion.
 *
 * Sequence per spec:
 *   1. SEND_ENCAPSULATED_COMMAND (control OUT)
 *   2. Device posts a 1-element RESPONSE_AVAILABLE notification on the
 *      interrupt-IN endpoint
 *   3. GET_ENCAPSULATED_RESPONSE (control IN)
 */
async function sendControlMessage(
  device: USBDevice,
  endpoints: Endpoints,
  message: Uint8Array,
  log: (msg: string) => void,
): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer (some backends reject Uint8Array views over a larger buffer).
  const outBuf = new ArrayBuffer(message.byteLength);
  new Uint8Array(outBuf).set(message);

  const outResult = await device.controlTransferOut(
    {
      requestType: 'class',
      recipient: 'interface',
      request: CDC_REQ_SEND_ENCAPSULATED_COMMAND,
      value: 0,
      index: endpoints.controlInterface,
    },
    outBuf,
  );
  if (outResult.status !== 'ok' || outResult.bytesWritten !== outBuf.byteLength) {
    throw new Error(
      `SEND_ENCAPSULATED_COMMAND failed: status=${outResult.status} written=${outResult.bytesWritten}/${outBuf.byteLength}`,
    );
  }

  // Wait inline for the RESPONSE_AVAILABLE notification on the interrupt EP.
  // The persistent-reader approach raced with this single read; sequential
  // is simpler and matches what most stacks (Linux's rndis_host) do.
  try {
    const noteResult = await device.transferIn(endpoints.interruptIn, endpoints.interruptInPacketSize);
    if (noteResult.status !== 'ok' || !noteResult.data) {
      log(`interrupt-IN status: ${noteResult.status}`);
    }
  } catch (err) {
    log(`interrupt-IN error: ${(err as Error).message}`);
  }

  const inResult = await device.controlTransferIn(
    {
      requestType: 'class',
      recipient: 'interface',
      request: CDC_REQ_GET_ENCAPSULATED_RESPONSE,
      value: 0,
      index: endpoints.controlInterface,
    },
    RNDIS_MAX_CONTROL_MESSAGE,
  );
  if (inResult.status !== 'ok' || !inResult.data) {
    throw new Error(`GET_ENCAPSULATED_RESPONSE failed: status=${inResult.status}`);
  }
  return new Uint8Array(inResult.data.buffer, inResult.data.byteOffset, inResult.data.byteLength);
}

