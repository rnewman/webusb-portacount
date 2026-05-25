# PortaCount 8020 Bluetooth UART adapter — design notes

Working notes for building an **M5Stack NanoC6 (ESP32-C6) + RJ45 + BLE**
adapter that bridges an older PortaCount 8020 to a BLE UART client
(e.g. fit-test-console via Web Bluetooth).

This is parallel work to the main repo, which targets the **8030** over
WebUSB/NDIS. The 8020 is the older sibling: serial-over-RJ45 instead of
USB.

## Files in this directory

- `physical-cable.md` — RJ45 pinout, electrical levels (RS-232 vs TTL),
  reference cable construction, bench-probe procedure for filling in the
  one missing piece (TX/RX/GND pin assignments).
- `wire-protocol.md` — UART parameters, full command vocabulary, response
  regexes, line formats. Lifted from emcee5601/fit-test-console.

## Authoritative external references

Ranked by trustworthiness for *this device* (others may apply better to
8020M, 8028 etc.):

1. **TSI PortaCount 8020 Technical Addendum** — official pinout on
   pp.10–11, protocol on p.13+:
   `https://tsi.com/getmedia/0d5db6cd-c54d-4644-8c31-40cc8c9d8a9f/PortaCount_Model_8020_Technical_Addendum_US?ext=.pdf`

2. **Andrzej Hunt's connection guide** — practical cabling options,
   tested:
   `https://www.ahunt.org/2026/03/the-many-ways-of-connecting-to-your-portacount/`
   - Pinout doc: `https://github.com/ahunt/incolata/blob/main/docs/8020.md`
   - Library: `https://github.com/ahunt/libp8020` (Rust; local at `../../libp8020`)
   - C++ client: `https://github.com/ahunt/incolata`

3. **emcee5601 fit-test-console** — TypeScript reference implementation
   (local at `../../fit-test-console`):
   `https://github.com/emcee5601/fit-test-console`
   - `src/external-control.ts` — every command + response pattern
   - `src/portacount-client-8020.ts` — parser regexes for unsolicited output
   - `src/porta-count-8020-simulator.ts` — device-side reference

4. **paul-hammant/PortaCount-8020A** — minimal Python reader:
   `https://github.com/paul-hammant/PortaCount-8020A/blob/main/portacount.py`

### Less reliable / informational only

- **emcee5601 fit-testing-resources wiki — Data Cable page**:
  `https://github.com/emcee5601/fit-testing-resources/wiki/Data-Cable`
  — the "Option B" reorder rule and "pin 1 = CTS" claim are
  **inconsistent** with the TSI addendum (which lists pin 1 as NC and
  CTS at pin 8). Use only as broad context.
- **Excalidraw schematic** (visualization of the wiki's reorder rule,
  same issue):
  `https://excalidraw.com/#json=ZnNQCzb09f6buh_sFGBu6,goClI1rhdv1r7KlhY-lUVw`

## Status

**Pinout:** resolved. Authoritative source is TSI Tech Addendum p.10:
TxD=pin 5, RxD=pin 3, GND=pin 7, CTS=pin 8, DTR=pin 2; pins 1, 4, 6
unused. See `physical-cable.md`.

**Protocol:** resolved. See `wire-protocol.md`.

**Open question:** does the 8020 actually gate transmission on CTS in
practice? Andrzej notes "the older 8020 did not support flow control"
despite documentation suggesting it should. Plan to tie CTS HIGH on the
ESP32 side and leave it at that.
