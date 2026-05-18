/**
 * Minimal pcap writer for Ethernet frames. Used by probe scripts to
 * capture exactly the bytes that crossed our virtual wire (USB ↔ lwIP)
 * for offline analysis in Wireshark/tshark.
 *
 * Format: classic pcap (not pcapng), little-endian, microsecond timestamps,
 * link-layer type DLT_EN10MB (1).
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

const PCAP_LINKTYPE_ETHERNET = 1;
const SNAPLEN = 65535;

export function openPcap(path: string): WriteStream {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(0xa1b2c3d4, 0); // magic (us-resolution)
  header.writeUInt16LE(2, 4);          // major version
  header.writeUInt16LE(4, 6);          // minor version
  header.writeInt32LE(0, 8);           // tz offset
  header.writeUInt32LE(0, 12);         // ts accuracy
  header.writeUInt32LE(SNAPLEN, 16);
  header.writeUInt32LE(PCAP_LINKTYPE_ETHERNET, 20);
  stream.write(header);
  return stream;
}

export function pcapWriteFrame(stream: WriteStream, frame: Uint8Array): void {
  const now = Date.now();
  const rec = Buffer.alloc(16 + frame.byteLength);
  rec.writeUInt32LE(Math.floor(now / 1000), 0);    // seconds
  rec.writeUInt32LE((now % 1000) * 1000, 4);       // microseconds
  rec.writeUInt32LE(frame.byteLength, 8);          // captured length
  rec.writeUInt32LE(frame.byteLength, 12);         // original length
  Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength).copy(rec, 16);
  stream.write(rec);
}

/**
 * Convenience wrapper: open a pcap and return both the stream and a
 * write-frame function bound to it. Tracks the frame count so the
 * caller can log it on shutdown.
 */
export function openPcapWriter(path: string): {
  path: string;
  write: (frame: Uint8Array) => void;
  close: () => Promise<void>;
  get frameCount(): number;
} {
  const stream = openPcap(path);
  let count = 0;
  return {
    path,
    write(frame) {
      pcapWriteFrame(stream, frame);
      count++;
    },
    close() {
      return new Promise<void>((resolve) => stream.end(() => resolve()));
    },
    get frameCount() { return count; },
  };
}
