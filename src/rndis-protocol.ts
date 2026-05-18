/**
 * RNDIS (Remote NDIS) protocol primitives.
 *
 * Pure encode/decode helpers for the RNDIS message family used between a
 * USB host and a network adapter. All multi-byte fields are little-endian.
 *
 * Reference: Microsoft "Remote NDIS Specification" (MS-RNDIS).
 */

// ---------- Message types (host → device) ----------
export const RNDIS_PACKET_MSG = 0x00000001;
export const RNDIS_INITIALIZE_MSG = 0x00000002;
export const RNDIS_HALT_MSG = 0x00000003;
export const RNDIS_QUERY_MSG = 0x00000004;
export const RNDIS_SET_MSG = 0x00000005;
export const RNDIS_RESET_MSG = 0x00000006;
export const RNDIS_KEEPALIVE_MSG = 0x00000008;

// ---------- Completion types (device → host) ----------
export const RNDIS_INITIALIZE_CMPLT = 0x80000002;
export const RNDIS_QUERY_CMPLT = 0x80000004;
export const RNDIS_SET_CMPLT = 0x80000005;
export const RNDIS_RESET_CMPLT = 0x80000006;
export const RNDIS_KEEPALIVE_CMPLT = 0x80000008;

// ---------- Status indication (device → host, unsolicited) ----------
export const RNDIS_INDICATE_STATUS_MSG = 0x00000007;

// ---------- Status codes ----------
export const RNDIS_STATUS_SUCCESS = 0x00000000;
export const RNDIS_STATUS_FAILURE = 0xc0000001;
export const RNDIS_STATUS_INVALID_DATA = 0xc0010015;
export const RNDIS_STATUS_NOT_SUPPORTED = 0xc00000bb;
export const RNDIS_STATUS_MEDIA_CONNECT = 0x4001000b;
export const RNDIS_STATUS_MEDIA_DISCONNECT = 0x4001000c;

// ---------- OIDs ----------
export const OID_GEN_SUPPORTED_LIST = 0x00010101;
export const OID_GEN_HARDWARE_STATUS = 0x00010102;
export const OID_GEN_MEDIA_SUPPORTED = 0x00010103;
export const OID_GEN_MEDIA_IN_USE = 0x00010104;
export const OID_GEN_MAXIMUM_FRAME_SIZE = 0x00010106;
export const OID_GEN_LINK_SPEED = 0x00010107;
export const OID_GEN_TRANSMIT_BLOCK_SIZE = 0x0001010a;
export const OID_GEN_RECEIVE_BLOCK_SIZE = 0x0001010b;
export const OID_GEN_VENDOR_ID = 0x0001010c;
export const OID_GEN_VENDOR_DESCRIPTION = 0x0001010d;
export const OID_GEN_CURRENT_PACKET_FILTER = 0x0001010e;
export const OID_GEN_MAXIMUM_TOTAL_SIZE = 0x00010111;
export const OID_GEN_MEDIA_CONNECT_STATUS = 0x00010114;
export const OID_GEN_PHYSICAL_MEDIUM = 0x00010202;
export const OID_802_3_PERMANENT_ADDRESS = 0x01010101;
export const OID_802_3_CURRENT_ADDRESS = 0x01010102;
export const OID_802_3_MULTICAST_LIST = 0x01010103;
export const OID_802_3_MAXIMUM_LIST_SIZE = 0x01010104;

// ---------- Packet-filter bits (for OID_GEN_CURRENT_PACKET_FILTER) ----------
export const NDIS_PACKET_TYPE_DIRECTED = 0x0001;
export const NDIS_PACKET_TYPE_MULTICAST = 0x0002;
export const NDIS_PACKET_TYPE_ALL_MULTICAST = 0x0004;
export const NDIS_PACKET_TYPE_BROADCAST = 0x0008;
export const NDIS_PACKET_TYPE_PROMISCUOUS = 0x0020;

// ---------- Control transfer constants ----------
/** SEND_ENCAPSULATED_COMMAND request (CDC class). */
export const CDC_REQ_SEND_ENCAPSULATED_COMMAND = 0x00;
/** GET_ENCAPSULATED_RESPONSE request (CDC class). */
export const CDC_REQ_GET_ENCAPSULATED_RESPONSE = 0x01;

/** Max response size we ask for on GET_ENCAPSULATED_RESPONSE. RNDIS spec caps replies at 1025 bytes; round up. */
export const RNDIS_MAX_CONTROL_MESSAGE = 1025;

/** Notification on interrupt EP: 8 bytes, first u32 = 0x00000001 = RESPONSE_AVAILABLE. */
export const RNDIS_NOTIFICATION_RESPONSE_AVAILABLE = 0x00000001;

// ---------- Encoders ----------

/**
 * REMOTE_NDIS_INITIALIZE_MSG (24 bytes).
 *
 * Negotiates protocol version and max transfer size with the device.
 * Must be sent first; the device won't process anything else until init completes.
 */
export function encodeInitializeMsg(requestId: number, maxTransferSize = 0x4000): Uint8Array {
  const buf = new Uint8Array(24);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_INITIALIZE_MSG, true);
  dv.setUint32(4, 24, true);            // MessageLength
  dv.setUint32(8, requestId, true);
  dv.setUint32(12, 1, true);            // MajorVersion
  dv.setUint32(16, 0, true);            // MinorVersion
  dv.setUint32(20, maxTransferSize, true);
  return buf;
}

/**
 * REMOTE_NDIS_QUERY_MSG with empty input buffer (28 bytes).
 *
 * Most queries we care about (MAC address, link speed, MTU) take no input.
 *
 * Note: the spec says InfoBufferOffset MUST be 0 when InfoBufferLength is 0,
 * but Linux's `rndis_host` always sets it to 20 (offset to byte right after
 * the header). Some embedded RNDIS firmwares (including the Portacount 8030)
 * STALL the control endpoint if we use the spec-correct 0. We follow Linux.
 */
export function encodeQueryMsg(requestId: number, oid: number): Uint8Array {
  const buf = new Uint8Array(28);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_QUERY_MSG, true);
  dv.setUint32(4, 28, true);            // MessageLength
  dv.setUint32(8, requestId, true);
  dv.setUint32(12, oid, true);
  dv.setUint32(16, 0, true);            // InfoBufferLength
  dv.setUint32(20, 20, true);           // InfoBufferOffset (Linux convention; see comment)
  dv.setUint32(24, 0, true);            // Reserved (DeviceVcHandle)
  return buf;
}

/**
 * REMOTE_NDIS_SET_MSG with a 4-byte little-endian uint32 payload (32 bytes).
 *
 * Used for filter/value settings where the OID expects a single uint32 (e.g.
 * OID_GEN_CURRENT_PACKET_FILTER).
 */
export function encodeSetU32Msg(requestId: number, oid: number, value: number): Uint8Array {
  const buf = new Uint8Array(32);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_SET_MSG, true);
  dv.setUint32(4, 32, true);            // MessageLength
  dv.setUint32(8, requestId, true);
  dv.setUint32(12, oid, true);
  dv.setUint32(16, 4, true);            // InfoBufferLength
  dv.setUint32(20, 20, true);           // InfoBufferOffset (from start of RequestID = byte 8; payload at byte 28; 28-8=20)
  dv.setUint32(24, 0, true);            // Reserved
  dv.setUint32(28, value, true);
  return buf;
}

/** REMOTE_NDIS_HALT_MSG (12 bytes). No response is sent. */
export function encodeHaltMsg(requestId: number): Uint8Array {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_HALT_MSG, true);
  dv.setUint32(4, 12, true);
  dv.setUint32(8, requestId, true);
  return buf;
}

/** REMOTE_NDIS_KEEPALIVE_MSG (12 bytes). */
export function encodeKeepaliveMsg(requestId: number): Uint8Array {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_KEEPALIVE_MSG, true);
  dv.setUint32(4, 12, true);
  dv.setUint32(8, requestId, true);
  return buf;
}

/**
 * REMOTE_NDIS_RESET_MSG (12 bytes).
 *
 * Unlike other host→device messages, RESET carries no RequestId — it's
 * the protocol's "everything is broken, reset state" escape hatch and
 * is used when normal request/response is no longer reliable. Useful
 * to send first thing on `open()` when a previous process left the
 * device's RNDIS state machine initialized.
 */
export function encodeResetMsg(): Uint8Array {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_RESET_MSG, true);
  dv.setUint32(4, 12, true);
  dv.setUint32(8, 0, true);             // Reserved
  return buf;
}

/**
 * REMOTE_NDIS_PACKET_MSG (44-byte header + Ethernet payload).
 *
 * Wraps an Ethernet frame for transmission on the bulk OUT endpoint.
 */
export function encodePacketMsg(ethernetFrame: Uint8Array): Uint8Array {
  const headerLen = 44;
  const buf = new Uint8Array(headerLen + ethernetFrame.byteLength);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, RNDIS_PACKET_MSG, true);
  dv.setUint32(4, buf.byteLength, true);
  // DataOffset is measured from the start of the DataOffset field (byte 8).
  // Payload starts at byte 44, so DataOffset = 44 - 8 = 36.
  dv.setUint32(8, 36, true);
  dv.setUint32(12, ethernetFrame.byteLength, true);
  // OOB and PerPacketInfo fields all zero — bytes 16..43 are already zero from Uint8Array init.
  buf.set(ethernetFrame, headerLen);
  return buf;
}

// ---------- Decoders ----------

export interface InitializeCmplt {
  messageType: number;       // 0x80000002
  messageLength: number;
  requestId: number;
  status: number;            // 0 == RNDIS_STATUS_SUCCESS
  majorVersion: number;
  minorVersion: number;
  deviceFlags: number;
  medium: number;            // 0 == 802.3
  maxPacketsPerTransfer: number;
  maxTransferSize: number;
  packetAlignmentFactor: number;
}

export function decodeInitializeCmplt(buf: Uint8Array): InitializeCmplt {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    messageType: dv.getUint32(0, true),
    messageLength: dv.getUint32(4, true),
    requestId: dv.getUint32(8, true),
    status: dv.getUint32(12, true),
    majorVersion: dv.getUint32(16, true),
    minorVersion: dv.getUint32(20, true),
    deviceFlags: dv.getUint32(24, true),
    medium: dv.getUint32(28, true),
    maxPacketsPerTransfer: dv.getUint32(32, true),
    maxTransferSize: dv.getUint32(36, true),
    packetAlignmentFactor: dv.getUint32(40, true),
  };
}

export interface QueryCmplt {
  messageType: number;       // 0x80000004
  messageLength: number;
  requestId: number;
  status: number;
  /** Slice of `buf` containing the OID's response payload. */
  infoBuffer: Uint8Array;
}

export function decodeQueryCmplt(buf: Uint8Array): QueryCmplt {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const infoBufferLength = dv.getUint32(16, true);
  const infoBufferOffset = dv.getUint32(20, true);
  // InfoBufferOffset is measured from the start of the RequestID field (byte 8).
  const payloadStart = 8 + infoBufferOffset;
  const infoBuffer = infoBufferLength === 0
    ? new Uint8Array(0)
    : buf.subarray(payloadStart, payloadStart + infoBufferLength);
  return {
    messageType: dv.getUint32(0, true),
    messageLength: dv.getUint32(4, true),
    requestId: dv.getUint32(8, true),
    status: dv.getUint32(12, true),
    infoBuffer,
  };
}

export interface SetCmplt {
  messageType: number;       // 0x80000005
  messageLength: number;
  requestId: number;
  status: number;
}

export function decodeSetCmplt(buf: Uint8Array): SetCmplt {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    messageType: dv.getUint32(0, true),
    messageLength: dv.getUint32(4, true),
    requestId: dv.getUint32(8, true),
    status: dv.getUint32(12, true),
  };
}

export interface ResetCmplt {
  messageType: number;       // 0x80000006
  messageLength: number;
  status: number;
  /** Non-zero means MAC, packet filter, etc. were reset and must be re-issued. */
  addressingReset: number;
}

export function decodeResetCmplt(buf: Uint8Array): ResetCmplt {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    messageType: dv.getUint32(0, true),
    messageLength: dv.getUint32(4, true),
    status: dv.getUint32(8, true),
    addressingReset: dv.getUint32(12, true),
  };
}

/**
 * Walk a bulk-IN transfer buffer that may contain one or more RNDIS messages
 * (PACKET_MSG, INDICATE_STATUS_MSG, etc) back-to-back.
 *
 * Yields each message as a sub-Uint8Array view (no copies). Stops on the first
 * malformed length.
 */
export function* iterateMessages(buf: Uint8Array): Generator<Uint8Array> {
  let pos = 0;
  while (pos + 8 <= buf.byteLength) {
    const dv = new DataView(buf.buffer, buf.byteOffset + pos, buf.byteLength - pos);
    const len = dv.getUint32(4, true);
    if (len < 8 || pos + len > buf.byteLength) return;
    yield buf.subarray(pos, pos + len);
    pos += len;
  }
}

/**
 * Extract the Ethernet frame from a PACKET_MSG.
 *
 * Returns a sub-Uint8Array view into `pkt`. Caller should copy if it needs
 * to retain the data beyond the lifetime of the bulk-transfer buffer.
 */
export function extractPacketPayload(pkt: Uint8Array): Uint8Array {
  const dv = new DataView(pkt.buffer, pkt.byteOffset, pkt.byteLength);
  // DataOffset is from the start of the DataOffset field (byte 8).
  const dataOffset = dv.getUint32(8, true);
  const dataLength = dv.getUint32(12, true);
  const start = 8 + dataOffset;
  return pkt.subarray(start, start + dataLength);
}
