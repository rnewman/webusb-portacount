# WebUSB connectivity for the PortaCount Pro 8030

PortaCount® is a trademark of [TSI Incorporated](https://tsi.com). This
software is not made, supported, or warranted by TSI.

## What this is

Older PortaCount models use a simple serial connection. Newer models —
including the 8030 — present as a USB network adapter. To talk to one
from a browser you need a full TCP/IP stack alongside WebUSB.

This repo implements that connectivity:

- a TypeScript wire layer over RNDIS bulk transfers,
- lwIP compiled to WebAssembly for the TCP/IP stack,
- a TypeScript client for the device's XML-over-TCP command/response
  protocol,
- a small developer-validation web app on top.

WebUSB is Chromium-only: Chrome and Edge on macOS, Linux, and Windows.
Firefox and Safari do not implement WebUSB.

## The stack

```
┌─────────────────────────────────────────────────────────┐
│ 5. Application                                          │  webapp/main.ts
│    UI or CLI; wires the layers below together           │  scripts/probe-handshake.ts
├─────────────────────────────────────────────────────────┤
│ 4. Protocol (Portacount)                                │  src/portacount.ts
│    XML commands / responses over TCP                    │  src/response-assembler.ts
├─────────────────────────────────────────────────────────┤
│ 3. Network (lwIP-in-Wasm)                               │  csrc/*, src/lwip-wasm.ts
│    TCP / IP / ARP / DHCP / AutoIP                       │
├─────────────────────────────────────────────────────────┤
│ 2. Wire (RNDIS over USB bulk)                           │  src/rndis.ts
│    Ethernet frames ↔ RNDIS PACKET_MSG over USB bulk     │  src/rndis-protocol.ts
├─────────────────────────────────────────────────────────┤
│ 1. Transport (WebUSB)                                   │  WebUSB API (browser)
│    `device.transferOut/transferIn` on bulk endpoints    │  `usb` package's
│                                                         │  WebUSB shim (node)
└─────────────────────────────────────────────────────────┘
```

Each layer splits into **a pure piece** (codecs, framers, parsers — no
time, no I/O) and **an orchestration piece** (state machine, timers,
promises). The pure parts compose; the orchestration parts wrap the
layer below and present a narrower interface upward.

### 1. Transport (WebUSB)

Not ours. `navigator.usb` in the browser, the `usb` package's WebUSB
shim in node. We claim two interfaces (RNDIS communications + CDC
data), issue `controlTransferOut/In` for RNDIS control, and
`transferOut/In` on bulk endpoints for data frames.

### 2. Wire (RNDIS)

`src/rndis-protocol.ts` is pure: encode/decode RNDIS messages
(INITIALIZE, SET, PACKET, completions, status indications).

`src/rndis.ts` is the orchestration: claims USB interfaces, runs the
INITIALIZE handshake, sets the packet filter, then exposes a
`WireLayer` (`src/wire-layer.ts`). Upward, the rest of the stack sees
only "raw Ethernet frames"; the RNDIS quirks stay hidden.

### 3. Network (lwIP-in-Wasm)

`csrc/glue.c` exposes a narrow C API (`lwip_wasm_*`) plus a few
`EM_JS` callbacks back into JS. `src/lwip-wasm.ts` wraps that as a
`LwipStack` class. The wasm module knows nothing about USB or
Portacount; it sees Ethernet frames in/out and TCP/UDP up.

Wire and network are glued together at the application layer with two
function references — `wire.startReceiving(f => stack.injectFrame(f))`
inbound, `stack.create(…, f => wire.sendFrame(f))` outbound. Neither
layer imports the other.

Addressing modes (static / AutoIP / DHCP) are a constructor argument;
addressing state is read back via `stack.{ip,gateway,netmask}` getters.

### 4. Protocol (Portacount)

`src/response-assembler.ts` is pure: `ResponseAssembler.push(bytes)`
returns `{kind:'complete', bytes} | {kind:'incomplete'}` based on the
`\r\r` terminator. `takeBuffered()` covers the cases where completion
is signalled some other way (peer close, quiescence timer).

`src/portacount.ts` is the orchestration: a small state machine
(`idle → connecting → connected → closing`), per-exchange timeouts, a
200 ms quiescence timer for responses without a `\r\r` terminator, the
handshake script, and keep-alives. Upward, the application sees
`command(xml) → Promise<string>`.

### 5. Application

`scripts/probe-handshake.ts` is the canonical wiring example: open USB
→ open RNDIS → create lwIP stack with DHCP → poll for a lease →
runtime-probe port 3602 → handshake port 3603 → realtime sample.

The webapp (`webapp/`) does the same with a UI on top.

For a deeper walk through a single `command()` round-trip and the
testing strategy, see [`docs/TESTING.md`](docs/TESTING.md).

## Development setup

### Prerequisites

- **Node.js** v18+
- **Chromium-based browser** (Chrome, Edge) — WebUSB is not supported
  in Firefox or Safari.
- **Emscripten SDK** — installed locally as a sibling submodule (see
  below); do not rely on a system-wide emsdk.
- (Linux only) the `libusb-1.0` development headers if you intend to
  run the node-side probe scripts: `apt install libusb-1.0-0-dev` or
  equivalent. macOS doesn't need a separate install.

### First-time setup

```bash
# Clone with submodules (lwIP).
git clone --recursive <repo-url>
cd webusb

# If you already cloned without --recursive:
# git submodule update --init --recursive

# Install emsdk (Emscripten toolchain).
git clone https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install latest
./emsdk/emsdk activate latest

# Activate emsdk for this shell (only needed if you call emcc directly;
# scripts/build-wasm.sh sources this for you).
source ./emsdk/emsdk_env.sh

# Install npm dependencies.
npm install

# Build the lwIP Wasm module.
npm run build:wasm

# Start the dev server.
npm run dev
```

Then open <http://localhost:5173> in Chrome. The validation page shows
whether the Wasm module loaded and lwIP initialised successfully, and
lets you connect to a device.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run build:wasm` | Compile lwIP to WebAssembly via Emscripten. |
| `npm run dev` | Start the Vite dev server for the webapp. |
| `npm run build` | Full build (Wasm + Vite production bundle). |
| `npm run typecheck` | TypeScript type checking. |
| `npm test` | Run the unit + integration test suite (Vitest). |
| `npm run probe` | Node-side connectivity probe. **Requires a connected device** and WebUSB-capable host. |
| `npm run probe:tcp` | TCP-level probe (port 3602/3603) once the stack is up. |
| `npm run probe:listen` | Passive listener — log everything the device sends without sending anything back. |
| `npm run probe:handshake` | Full handshake walk; emits a pcap to `captures/`. |
| `npm run dump:pcap` | Stream captured Ethernet frames into a pcap file for Wireshark. |

The `probe:*` scripts use the node [`usb`](https://www.npmjs.com/package/usb)
package (libusb under the hood) rather than browser WebUSB. They need
the device plugged in and the OS to **not** have already claimed the
USB interfaces (on macOS this is usually fine; on Linux you may need a
udev rule).

## Project structure

```
webusb/
├── csrc/                    C glue + lwIP port (Emscripten build)
│   ├── glue.c               Wire layer: frame I/O between JS ↔ lwIP
│   ├── sys_arch.c           lwIP NO_SYS port (sys_now via performance.now)
│   └── include/
│       ├── lwipopts.h       lwIP config (NO_SYS, IPv4, TCP, AutoIP)
│       └── arch/cc.h        Platform defs for Emscripten/Wasm
├── vendor/
│   └── lwip/                Git submodule — lwIP 2.2.x source
├── src/                     TypeScript library
│   ├── wire-layer.ts        WireLayer interface (RNDIS/CDC-ECM contract)
│   ├── rndis-protocol.ts    Pure RNDIS message codec
│   ├── rndis.ts             RNDIS orchestration over WebUSB
│   ├── cdc-ecm.ts           CDC-ECM stub
│   ├── virtual-wire.ts      In-process WireLayer for integration tests
│   ├── lwip-wasm.ts         Typed wrapper around the Wasm module
│   ├── response-assembler.ts Pure XML-stream framing
│   ├── portacount.ts        Protocol orchestration: state machine, timers
│   └── index.ts             Re-exports
├── webapp/                  Developer validation app
│   ├── index.html
│   ├── main.ts
│   ├── session-store.ts     Session recording (localStorage-backed)
│   ├── session-panel.ts     History panel
│   ├── session-ui.ts        Live readouts + graphs
│   └── style.css
├── test/                    Unit + integration tests (Vitest)
├── scripts/                 Node-side probes + build script
│   ├── build-wasm.sh
│   ├── probe-handshake.ts
│   ├── probe-tcp.ts
│   ├── probe-listen.ts
│   ├── probe-portacount.ts
│   ├── probe-rndis.ts
│   ├── dump-pcap.ts
│   └── syn-scan.ts
├── docs/
│   └── TESTING.md           Test strategy + control-flow trace
├── captures/                pcap output (gitignored)
├── emsdk/                   Emscripten SDK (gitignored)
└── build/                   Wasm build output (gitignored)
```
