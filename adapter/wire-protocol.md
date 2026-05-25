# PortaCount 8020 wire protocol

Reference: TSI Technical Addendum (commands from p.13) and
`emcee5601/fit-test-console` (`src/external-control.ts`,
`src/portacount-client-8020.ts`, `src/porta-count-8020-simulator.ts`).

All strings here are ASCII. Lines are terminated by `\r`, `\n`, or
`\r\n` depending on direction (the JS parser accepts any).
Commands sent to the device end in `\r`.

## Commands (host → device)

Every command is a short ASCII string ending in `\r`. Most commands are
**echoed back** by the device as their own acknowledgment. Exceptions
are listed in the response patterns below.

### Mode control

| Command | Meaning | Notes |
|---------|---------|-------|
| `J`     | Invoke external control mode | Replies `OK` (first time) or `EJ` (already external) |
| `G`     | Release external control (return to internal) | Replies `G` |
| `Y`     | Turn device power off | Replies `Y` |

### Data transmission

| Command | Meaning |
|---------|---------|
| `ZE`    | Enable continuous data transmission |
| `ZD`    | Disable continuous data transmission |

### Sampling valve

| Command | Meaning |
|---------|---------|
| `VN`    | Switch valve to **ambient** sampling |
| `VF`    | Switch valve to **mask** sampling |

### Status / introspection

| Command | Meaning |
|---------|---------|
| `R`     | Request runtime status (battery + signal pulse). Replies `RXY` where X,Y ∈ {G,B} |
| `C`     | Request component voltages (undocumented; replies multiple `C?nnn` lines) |
| `S`     | Request all settings (replies a long burst of `S…` lines) |
| `Q`     | Test for N95 companion attached. Replies `QY` or `QN` |

### Configuration (write — fails if write-protect DIP switch is on; error prefix `W`)

| Template | Meaning |
|----------|---------|
| `PTMxxvv`     | Set mask sample time. `xx` = exercise [01..12], `vv` = seconds [10..99] |
| `PTA00vv`     | Set ambient sample time. `vv` = seconds [05..99] |
| `PTPM0vv`     | Set mask sample purge time. `vv` = seconds [11..25] |
| `PTPA0vv`     | Set ambient sample purge time. `vv` = seconds [04..25] |
| `PPxxvvvvv`   | Set FF pass level. `xx` = memory slot [01..12], `vvvvv` = pass level [0..64000] |

### Display / sound (PortaCount Plus only)

| Template          | Meaning |
|-------------------|---------|
| `Dxxxxxx.xx`      | Display concentration |
| `Lxxxxxx`         | Display FF pass level |
| `Fxxxxxx.x`       | Display fit factor |
| `Axxxxxx.x`       | Display overall FF |
| `Ixxxxxxxx`       | Display exercise number |
| `K`               | Clear display |
| `Bxx`             | Beep for `xx` tenths of a second |

## Responses & unsolicited output (device → host)

### Generic error/write-protect prefixes

- `E<command>` — error, offending command echoed
- `W<command>` — write-protected (DIP switch 4)

### Command acknowledgments (regexes, ECMAScript flavor)

```js
SAMPLING_FROM_MASK         = /^VF$/        // wiki/manual says VO; devices emit VF
SAMPLING_FROM_AMBIENT      = /^VN$/
DATA_TRANSMISSION_DISABLED = /^ZD$/
DATA_TRANSMISSION_ENABLED  = /^ZE$/
EXTERNAL_CONTROL           = /^(OK|EJ)$/   // OK first time; EJ if already external
INTERNAL_CONTROL           = /^G$/
TURN_POWER_OFF             = /^Y$/
N95_COMPANION              = /^Q(?<connected>[YN])/i
SETTINGS_LINE              = /^S.+$/
```

### Continuous data — external control mode

One zero-padded concentration per second:

```
006408.45
```

Regex:
```js
PARTICLE_COUNT = /^(?<timestamp>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d.\d{3}Z)?\s*(?<concentration>\d+\.\d+)\s*/
```

(The timestamp prefix is added by fit-test-console's log layer, not by
the device. Adapter firmware should not emit it.)

### Continuous data — internal control mode

Roughly every 2 seconds:

```
Conc.      0.00 #/cc
Conc.     10200 #/cc
```

Regex:
```js
COUNT_READING = /^\s*Conc\.\s+(?<concentration>[\d.]+)/i
```

### Test progress (internal control mode)

```
NEW TEST PASS =  100         /^NEW\s+TEST\s+PASS\s*=\s*(?<passLevel>\d+)/i
Ambient   2290 #/cc          /^Ambient\s+(?<concentration>[\d.]+)/i
Mask    5.62 #/cc            /^Mask\s+(?<concentration>[\d+.]+)/i
FF  1    352 PASS            /^FF\s+(?<exerciseNumber>\d+)\s+(?<fitFactor>[\d.]+)\s+(?<result>.+)/
Overall FF    89 FAIL        /^Overall\s+FF\s+(?<fitFactor>[\d.]+)\s+(?<result>.+)/i
Test Terminated              /^Test\s+Terminated/i
970/cc Low Particle Count    /^(?<concentration>\d+)\/cc\s+Low\s+Particle\s+Count/i
```

### Status responses

```
RGG                          /^R(?<battery>.)(?<pulse>.)$/    // G=Good, B=Bad
CS191, CB483, CT236, ...     /^(?<component>C[SBTCLPD])(?<value>.+)$/
```

### Boot banner (only emitted at power-on)

```
PORTACOUNT PLUS PROM V1.7
COPYRIGHT(c)1992 TSI INC
ALL RIGHTS RESERVED
Serial Number 17754
FF pass level = 100
No. of exers  = 4
Ambt purge   = 4 sec.
Ambt sample  = 5 sec.
Mask purge  = 11 sec.
Mask sample 1 = 40 sec.
...
DIP switch  = 10111111
```

### Settings dump (response to `S`)

Each line is a `S…` record. Examples and regexes:

```js
STPA  000vv      Setting.Timing.AMBIENT_PURGE = /^STPA\s+(?<duration>\d+)/i
STPM  000vv      Setting.Timing.MASK_PURGE    = /^STPM\s+(?<duration>\d+)/i
STA   000vv      Setting.Timing.AMBIENT_SAMPLE= /^STA\s+(?<duration>\d+)/i
STMxx 000vv      Setting.Timing.MASK_SAMPLE   = /^STM(?<exercise_num>\d\d)(?<duration>\d+)/i
SP xxvvvvv       Setting.FF_PASS_LEVEL        = /^SP\s+(?<index>\d\d)(?<score>\d+)/i
SS vvvvv         Setting.SERIAL_NUMBER        = /^SS\s+(?<serial_number>\d+)/i
SR vvvvv         Setting.RUN_TIME...          = /^SR\s+(?<runtime>\d+)/i    // 10-min units
SD 0MMYY         Setting.LAST_SERVICE_DATE    = /^SD\s+0(?<month>\d\d)(?<year>\d\d)/i
```

A full simulator response burst is in
`fit-test-console/src/porta-count-8020-simulator.ts:174-208` — use it as
a golden reference for firmware testing.

## Command/response timing & retry

From `external-control.ts:118-145`:

- Command retry timeout: **3 seconds** per attempt
- Default max retries: **1** (most call sites), some use 0
- Commands are serialized: never send the next command until the
  previous one has been acknowledged

For an MVP transparent adapter, none of this matters — you just pump
bytes both ways. The retry logic only matters if the adapter itself
issues commands (e.g. to auto-enable data transmission on connect).

## Sync-on-connect sequence (fit-test-console default)

When syncOnConnect is enabled, the JS client does this after detecting
the device is ready:

1. Spam `J` (invoke external control) every 1 s until `OK` / `EJ`
   received (timeout 65 s)
2. `ZE`  — enable data transmission
3. `R`   — request runtime status
4. `S`   — request all settings
5. `C`   — request voltage info
6. `B01` × 3 — three short beeps as audible confirmation

A smart adapter could replicate this on BLE-client connect; a dumb
pass-through leaves it to the client app.
