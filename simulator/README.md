# PortaCount 8020 simulator

A standalone Node + WebSocket script that speaks the PortaCount 8020
wire protocol, so the webapp (and integration tests) can be developed
against without real hardware.

## Run

```
npx tsx simulator/portacount-8020.ts
```

Optional flags:

```
--port=N       Listen on a different WebSocket port (default 18020).
--verbose, -v  Log every command received and line emitted.
```

The simulator listens on `ws://localhost:18020`. Connect from the
webapp via the "Simulator" option in the driver picker, or from test
code via the `WebSocketByteStream` adapter.

## Protocol coverage

| Command         | Behavior                                               |
|-----------------|--------------------------------------------------------|
| `J`             | First call: `OK`. Subsequent: `EJ`.                    |
| `G`             | Echo `G`, leave external control.                      |
| `Y`             | Echo `Y`, stop ticking (simulates power-off).          |
| `ZE` / `ZD`     | Echo. ZE enables 1 Hz concentration stream.            |
| `VN` / `VF`     | Echo. Toggles `ambient` / `mask` sample side.          |
| `R`             | `RGG`.                                                 |
| `C`             | Multi-line voltage burst (CS191 / CB483 / …).          |
| `S`             | Echo `S`, then settings burst (STPA / STM / SP / …).   |
| `Q`             | `QN`.                                                  |
| `Bxx`           | Echo.                                                  |
| `PT…` / `PP…`   | Echo (no real persistence).                            |
| `SIM_RUN_FITTEST` | Internal-mode fit test fixture (NEW TEST PASS → …) |

The boot banner is emitted on connect.

## Data stream

- External control mode (after `J` then `ZE`): one zero-padded
  concentration per second, e.g. `006408.45\r`.
- Internal mode: `Conc.    nnnn.nn #/cc\r` every 2 seconds.

Mask-side readings are simulated at ~5% of the ambient target count
with ±10% jitter.

## Fit-test fixture

Sending `SIM_RUN_FITTEST` (a simulator-only command — not on real
8020s) sequences a four-exercise internal-mode test:

```
NEW TEST PASS = 100
Ambient   2290 #/cc
Mask    5.62 #/cc
FF  1    352 PASS
…
Overall FF    n PASS
```

This is the cheapest way to exercise the {@link FitTestRunner8020}
end-to-end.
