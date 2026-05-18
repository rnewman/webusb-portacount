/**
 * Layer-1 sanity check: open the Portacount, run the RNDIS handshake,
 * print the negotiated info, and close. No lwIP, no IP traffic.
 *
 * Useful as a first step in a fresh hardware-in-the-loop session to
 * confirm USB enumeration + RNDIS init are healthy before bringing
 * higher layers up.
 *
 * Run:  npx tsx scripts/probe-rndis.ts
 */

import { WebUSB } from 'usb';

import { RndisWireLayer } from '../src/rndis';

function log(msg: string): void {
  process.stderr.write(`[${new Date().toISOString()}] ${msg}\n`);
}

async function main(): Promise<void> {
  const webusb = new WebUSB({ allowAllDevices: true, deviceTimeout: 5000 });
  const devices = await webusb.getDevices();
  const device = devices.find(
    (d) =>
      d.vendorId === RndisWireLayer.USB_FILTER.vendorId &&
      d.productId === RndisWireLayer.USB_FILTER.productId,
  );
  if (!device) {
    log(`Portacount not found (looking for vid=0x${RndisWireLayer.USB_FILTER.vendorId!.toString(16)} pid=0x${RndisWireLayer.USB_FILTER.productId!.toString(16)}).`);
    log(`Visible: ${devices.map((d) => `0x${d.vendorId.toString(16)}/0x${d.productId.toString(16)}`).join(', ') || '(none)'}`);
    process.exit(1);
  }
  log(`found ${device.manufacturerName} / ${device.productName} (serial=${device.serialNumber})`);

  if (typeof (device as USBDevice & { reset?: () => Promise<void> }).reset === 'function') {
    try {
      if (!device.opened) await device.open();
      await (device as USBDevice & { reset: () => Promise<void> }).reset();
      log('device reset OK');
    } catch (err) {
      log(`device reset failed (continuing): ${(err as Error).message}`);
    }
  }

  const wire = await RndisWireLayer.open(device, { log });
  const info = wire.info;
  const macStr = [...info.macAddress].map((b) => b.toString(16).padStart(2, '0')).join(':');
  log(`RNDIS up. mac=${macStr} maxXfer=${info.maxTransferSize} maxPkts=${info.maxPacketsPerTransfer} align=${info.packetAlignment}B`);
  await wire.close();
  log('closed cleanly. RNDIS layer healthy.');
}

main().catch((err) => {
  log(`FATAL: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
