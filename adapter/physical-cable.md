# Physical cable — PortaCount 8020 RJ45

## Electrical levels: RS-232, NOT TTL

The 8020's RJ45 port is **RS-232 voltage levels** (±5 V to ±12 V),
*not* logic-level UART. Confirmed indirectly but unambiguously: every
documented cable in the emcee5601 wiki terminates at a DB9 USB-serial
adapter, which only works at RS-232 levels. There is no mention of a
level shifter anywhere in the documented build paths.

**Implication for the ESP32-C6 design:** an RS-232 transceiver
(MAX3232 or equivalent — the 3.3 V variant, *not* MAX232) is mandatory
between the RJ45 jack and the ESP32 UART pins. Driving an ESP32 GPIO
directly off this would blow the pin.

## Pin assignments — authoritative (TSI Technical Addendum p.10)

Quoting the addendum: *"Contacts are numbered 1 through 8 from left to
right when viewed as shown."* The "as shown" picture has the data port
on the back of the device, jack facing the viewer.

| Pin | Function          | Direction               |
|-----|-------------------|-------------------------|
| 1   | **Not used**      | —                       |
| 2   | Ready (DTR)       | From PortaCount Plus    |
| 3   | Receive data (Rx) | To PortaCount Plus      |
| 4   | **Not used**      | —                       |
| 5   | Transmit data (Tx)| From PortaCount Plus    |
| 6   | **Not used**      | —                       |
| 7   | Signal Ground     | —                       |
| 8   | Clear to send (CTS)| To PortaCount Plus     |

Lines are **RS-232 voltage levels** (±5 V to ±12 V).

### TSI's own RJ45→DB9 cable (Technical Addendum p.11, "9 pin RS-232 connectors")

| TSI RJ45 pin | DB9 pin (host DTE) |
|--------------|---------------------|
| 1 | 1 (DCD)  |
| 2 | 8 (CTS)  |
| 3 | 3 (TxD)  |
| 4 | 6 (DSR)  |
| 5 | 2 (RxD)  |
| 6 | 9 (RI)   |
| 7 | 5 (GND)  |
| 8 | 4 (DTR)  |

Note the deliberate crossovers: TSI's TxD (pin 5) lands at the PC's RxD
(DB9 2), and PC's TxD (DB9 3) reaches TSI's RxD (pin 3). For flow
control, TSI's DTR (pin 2) drives the PC's CTS (DB9 8), and PC's DTR
(DB9 4) drives TSI's CTS (pin 8) — TSI uses DTR as the host-side
flow-control output, not RTS.

### Why the emcee5601 wiki disagrees

The wiki's "Option B" reorder rule (1-4-2-3-5-6-7-8 with "1 = CTS")
is **inconsistent** with the official TSI pinout — pin 1 is explicitly
"Not used" per TSI. The wiki recipe is either for a different device
variant, a different connector-viewing convention, or just wrong.
Andrzej's "TSI's RJ45 ordering is the opposite of normal" remark
captures a real oddity (TSI does not use the Yost/Cisco signal-to-pin
convention — note the unused middle pins 4/6 instead of GND, and CTS at
pin 8 rather than the Yost RTS) but is not literally a numerical
reversal. Defer to TSI's own document.

### Confirmed by Andrzej Hunt's Option 1 (`incolata/docs/8020.md`)

Andrzej's DIY DB9 + Cat5e cable maps DB9 pins to wire colors as below.
Combined with T568B (the standard Ethernet color code), it agrees with
TSI's p.11 table:

| DB9 pin | Wire color (T568B) | T568B pin | matches TSI p.11? |
|---------|--------------------|----------:|-------------------|
| 1 | Brown          | 8 | ✓ (TSI 8 → DB9 4 → no — wait, p.11 says TSI 1 → DB9 1; Andrzej's is the symmetric variant) |
| 2 | Blue           | 4 | ✓ (TSI 5 ↔ DB9 2) |
| 3 | Green          | 6 | — (TSI assigns DB9 3 ↔ TSI 3; Andrzej routes via pin 6) |
| 5 | Orange         | 2 | (GND path) |

(Some pins differ because Andrzej picked a Cat5e cable where T568B
positions happen to differ from TSI's RJ45 contact positions — bench-
verify against the device you have.)

## The pinout you actually need for the ESP32-C6 adapter

| TSI pin | Wire | ESP32-C6 side via MAX3232 |
|---------|------|----------------------------|
| 3       | RxD into device | MAX3232 **T1OUT** ← ESP32 UART TX |
| 5       | TxD from device | MAX3232 **R1IN**  → ESP32 UART RX |
| 7       | GND             | common ground |
| 8       | CTS into device | tie HIGH at RS-232 levels (drive via a spare MAX3232 T-channel) to keep the device transmitting |
| 2       | DTR from device | leave NC (or read as link-live indicator via MAX3232 R-channel) |
| 1, 4, 6 | Not used        | leave NC |

## Bench-verifying the TSI pinout (sanity check before soldering)

Quick sanity check on a powered 8020 with nothing else connected:

1. **GND (expected: pin 7)** — multimeter on continuity, one probe on
   chassis. Pin 7 should beep.

2. **TxD (expected: pin 5)** — DC volts, black probe on pin 7. Pin 5
   should idle at **−5 V to −12 V** (RS-232 mark). To make it flicker,
   send `ZE\r` over a known path so the 8020 spews concentrations.

3. **DTR (expected: pin 2)** — should sit at **+5 to +12 V** (asserted
   while powered).

4. **CTS (expected: pin 8)** — passive input. If the 8020 won't
   transmit, jumper pin 8 to your local +12 V to confirm.

5. **Pins 1, 4, 6** — should float (no consistent voltage).

If any of these don't match, suspect a device variant (8020M gen1/gen2,
8028) and re-check against the addendum.

## Power: barrel-jack passthrough

The adapter sits **inline on the 8020's wall-PSU feed** — wall brick
plugs into the adapter, adapter passes power through to the 8020 (~800
mA), and taps off a small fraction for the NanoC6 + MAX3232. No second
cable to the device, no MMJ-6 sourcing.

```
Wall PSU ──► [barrel IN] ──┬──► [barrel OUT] ──► 8020 power jack
                           │
                           └──► buck (V_in → 5 V) ──► NanoC6 5 V
                                                 └──► LDO (5 V → 3.3 V) ──► MAX3232 Vcc
```

Notes:

- **Match the OEM barrel jack exactly** — measure diameter, polarity,
  and voltage on the original brick before ordering jacks. Reverse
  polarity into the 8020 could be expensive. (Most TSI-era bricks are
  center-positive, but confirm.)
- **Passthrough path** is unregulated: input rail → output rail
  straight through. Use 22 AWG or heavier for the trace/wire so the 800
  mA + transient peaks don't drop voltage. The buck only sees the
  small NanoC6 load.
- **Always-on by design**: when the 8020 is powered, the BLE adapter
  is too. If you ever want a hardware "off" for the adapter without
  unplugging the 8020, put a SPST on the buck input — but probably not
  worth it for v1.
- **N95 mode**: since we're not touching the ACCY port, N95-Companion
  auto-detect doesn't trigger. If N95 mode matters, drive it over the
  serial link with the appropriate command (see `wire-protocol.md`)
  rather than wiring ACCY pin 3.

### Accessory Port — reference only (not used in this design)

The 8020 has a second modular jack labeled "ACCY Port" (6-pin MMJ)
intended for the N95-Companion accessory. Pinout per TSI addendum p.10:
pin 1 = GND, pin 2 = +5 V, pin 3 = N95-attach sense (pull low to
assert), pin 4 = +5 V solenoid feed (high-current, don't tap), pin 5 =
solenoid valve control (device output), pin 6 = NC. Official harness is
TSI cable 1303522. Tap pin 1/2 if you ever need a power option that
doesn't sit inline on the wall PSU.

## A note on the grey passthrough adapter (your working setup)

The "unmodified Cat5e + HL340 + grey RJ45-DB9 adapter with 3 bent pins"
chain works because the grey adapter has a fixed pin-mapping that —
combined with straight-through Cat5e — connects TSI pin 5 → DB9 2,
TSI pin 3 → DB9 3, TSI pin 7 → DB9 5, and (probably) TSI pin 8 →
DB9 4 or 7 for the CTS path. The 3 bent pins are the NC contacts
(1, 4, 6) intentionally disconnected so they can't accidentally short
anything inside the adapter. If you want to capture the exact mapping
without disassembly, buzz it out with a multimeter pin-by-pin — RJ45 to
DB9 — in 5 minutes. That's the most reliable reference for your own
build.

## Default UART parameters

```
Baud:    1200
Bits:    8
Parity:  None
Stop:    1
Flow:    None (in practice; CTS is wired but optional — see README)
```

fit-test-console auto-detects among **300, 600, 1200, 2400, 9600**.
1200 is the factory default for the 8020.

DIP switches on the device select baud and other behavior; relevant
bits are parsed in `portacount-client-8020.ts` as the `DIP_switch`
pattern but the bit-to-meaning map isn't in the codebase — it's in the
TSI Technical Addendum.

## BOM sketch for the ESP32-C6 adapter

- 1× M5Stack NanoC6 (ESP32-C6, BLE 5.0 — no classic Bluetooth, so plan
  on **Nordic UART Service (NUS)** over BLE GATT). Has an onboard Grove
  port reusable as UART after remap.
- 1× MAX3232 breakout (the 3.3 V variant — *not* MAX232). On a basic
  breakout, the charge-pump caps are pre-populated.
- 1× AMS1117-3.3 LDO (or equivalent) to give the MAX3232 a clean 3.3 V
  rail — feeding it 5 V would push its TTL outputs to 5 V and fry the
  ESP32-C6 (3.3 V GPIO, *not* 5 V tolerant).
- 1× small buck converter (e.g. TPS562xx module or LM2596 board)
  stepping the 8020's PSU voltage down to 5 V at ~300 mA.
- 2× barrel jacks matched to the 8020's OEM PSU (one IN, one OUT —
  measure diameter, polarity, voltage before ordering).
- 1× RJ45 jack (8P8C, through-hole panel-mount with flying leads for
  bring-up; or a Cat5e socket-to-pigtail).
- 1× Grove cable (4-pin) between MAX3232 board and NanoC6's Grove port.
- Optional: TVS diodes on the RS-232 side for ESD, polyfuse on the
  buck input.

### Wiring

8020 Data Port ↔ MAX3232 (RS-232 side):

```
8020 RJ45 pin 5 (TxD) ──► MAX3232 R1IN
                          MAX3232 R1OUT ──► NanoC6 UART RX (Grove G1)
8020 RJ45 pin 3 (RxD) ◄── MAX3232 T1OUT
                          MAX3232 T1IN  ◄── NanoC6 UART TX (Grove G2)
8020 RJ45 pin 7 (GND) ─── common ground
8020 RJ45 pin 8 (CTS) ─── tie to MAX3232 V+ via 10 kΩ (forces CTS high
                          at RS-232 levels so device doesn't gate TX)
8020 RJ45 pins 1,2,4,6 ── no connect
```

(The "T" side is TTL→RS-232 driver, the "R" side is RS-232→TTL
receiver. Always cross-verify against the specific breakout's silkscreen
— some boards label them DI/DO/RI/RO instead.)

NanoC6 Grove ↔ adapter board (4-wire Grove cable):

```
red    +5 V  ← from buck on adapter board
black  GND
white  SIG  → NanoC6 G1 (remap to UART1 RX in firmware)
yellow SIG  → NanoC6 G2 (remap to UART1 TX in firmware)
```

NanoC6 firmware UART remap example (Arduino):
```cpp
Serial1.begin(1200, SERIAL_8N1, /*RX=*/1, /*TX=*/2);
```

Default Grove function on the NanoC6 is I²C — the remap is required.
