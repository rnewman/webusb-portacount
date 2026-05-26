# PortaCount 8020 wire protocol

Reference sources:

- TSI Technical Addendum (commands from p.13)
- `emcee5601/fit-test-console` (`src/external-control.ts`,
  `src/portacount-client-8020.ts`, `src/porta-count-8020-simulator.ts`)
- **Direct observation** against a real PortaCount 8020, firmware
  V2.5, S/N 44960, FTDI cable @ 1200 8N1, on 2026-05-25. Captures in
  `local/captures/8020/golden-*.{bin,log}`.

## Verification convention

The wire-protocol details below are **not equally trustworthy**. Some
have been observed end-to-end against real hardware; others come from
the wiki / TSI manual and have not yet been exercised. To keep
ourselves honest, every non-trivial claim is tagged:

| Tag | Meaning |
|-----|---------|
| ✅  | Verified against real hardware. Tag carries firmware version + capture date. |
| ❓  | Spec only. From the TSI Addendum or fit-test-console; *not* yet exercised. |
| ⚠️  | Spec contradicted by real hardware. Spec wording is left for context; reality is described in the note. |

Untagged general text (intros, headings, etc.) is editorial; only
factual claims about wire behavior need tags.

## Line endings

⚠️ Wiki claimed: "Lines are terminated by `\r`, `\n`, or `\r\n`
depending on direction."
**Reality (✅ V2.5, 2026-05-25):** every inbound line we have seen
ends with `\r\n`. We have not yet seen any line ending in a bare `\r`
or bare `\n` from real hardware. Our `LineAssembler` tolerates all
three forms, so this is a documentation issue, not a parsing issue.

Commands sent to the device end in a single `\r`. ✅ V2.5, 2026-05-25.

## Commands (host → device)

Every command is a short ASCII string ending in `\r`. **Most**
commands are echoed back by the device as their own acknowledgment.
**Exceptions** are listed in `COMMAND_ACK_OVERRIDES` in `patterns.ts`
and called out below.

### Mode control

| Command | Meaning | Verified |
|---------|---------|----------|
| `J`     | Invoke external control. Replies `OK` (first time) or `EJ` (already external). | ✅ V2.5, 2026-05-25 (got `OK`) |
| `G`     | Release external control (return to internal). Replies `G`. | ✅ V2.5, 2026-05-25 |
| `Y`     | Power off. Replies `Y` then powers down. | ❓ spec only — we have not tested this (it would shut the device down) |

### Data transmission

| Command | Meaning | Verified |
|---------|---------|----------|
| `ZE`    | Enable continuous data transmission. Echo ack. | ✅ V2.5, 2026-05-25 |
| `ZD`    | Disable continuous data transmission. Echo ack. | ✅ V2.5, 2026-05-25 |

Note (⚠️ V2.5, 2026-05-25): on real hardware, particle counts were
observed to stream even *without* a preceding `ZE`, after `J → R → S`.
Hypothesis: a prior session had `ZE` set and the device retains it
across `J/G` toggles. Until we have a clean power-on test confirming
"no data unless ZE", do not rely on `ZE`/`ZD` to fully gate the
data stream.

### Sampling valve

| Command | Meaning | Verified |
|---------|---------|----------|
| `VN`    | Switch valve to **ambient** sampling. Echo ack. | ✅ V2.5, 2026-05-25 (also audibly clicks) |
| `VF`    | Switch valve to **mask** sampling. Echo ack. | ✅ V2.5, 2026-05-25 |

### Status / introspection

| Command | Meaning | Verified |
|---------|---------|----------|
| `R`     | Runtime status. Replies `RXY` where X,Y ∈ {G,B} for battery/pulse. | ✅ V2.5, 2026-05-25 (got `RGG`) |
| `Q`     | Probe for N95 companion. Replies `QY` or `QN`. | ✅ V2.5, 2026-05-25 (got `QN`) |
| `S`     | Request all settings. **Does NOT echo** ⚠️ — burst starts directly with the first settings line (e.g. `STPA 00004`). | ✅ V2.5, 2026-05-25 |
| `C`     | Request component voltages (undocumented). Burst of `C?nnn` lines; ack assumed to also be the first burst line (no echo). | ✅ V2.5, 2026-05-25 (received burst; exact echo-vs-no-echo not confirmed in walk — we never saw a leading `C` echo, only voltage lines) |

⚠️ Wiki claimed `S` "replies a long burst of `S…` lines" with the
implication that the burst itself is the ack. Reality: yes, but the
queue's default "echo ack" model breaks here because the command `S`
itself is not echoed. We use first-line-of-burst as the ack pattern
in `COMMAND_ACK_OVERRIDES`.

### Configuration (write — fails if write-protect DIP switch is on; error prefix `W`)

| Template      | Meaning | Verified |
|---------------|---------|----------|
| `PTMxxvv`     | Set mask sample time. `xx` = exercise [01..**13**?], `vv` = seconds [10..99] | ❓ spec only |
| `PTA00vv`     | Set ambient sample time. `vv` = seconds [05..99] | ❓ spec only |
| `PTPM0vv`     | Set mask sample purge time. `vv` = seconds [11..25] | ❓ spec only |
| `PTPA0vv`     | Set ambient sample purge time. `vv` = seconds [04..25] | ❓ spec only |
| `PPxxvvvvv`   | Set FF pass level. `xx` = memory slot [01..12], `vvvvv` = pass level [0..64000] | ❓ spec only |

⚠️ Wiki said exercise count is capped at 12. Real V2.5 firmware's
`S` burst returns 13 `STM` slots (`STM01..STM13`). Either the cap is
13 in newer firmware, or slot 13 is a scratch / sentinel slot. The
`PTMxx` write range needs verification before relying on the [01..12]
bound — we may be able to address slot 13 too.

### Display / sound (PortaCount Plus only)

| Template          | Meaning | Verified |
|-------------------|---------|----------|
| `Dxxxxxx.xx`      | Display concentration | ❓ spec only |
| `Lxxxxxx`         | Display FF pass level | ❓ spec only |
| `Fxxxxxx.x`       | Display fit factor | ❓ spec only |
| `Axxxxxx.x`       | Display overall FF | ❓ spec only |
| `Ixxxxxxxx`       | Display exercise number | ❓ spec only |
| `K`               | Clear display | ❓ spec only |
| `Bxx`             | Beep for `xx` tenths of a second | ❓ spec only |

## Responses & unsolicited output (device → host)

### Generic error/write-protect prefixes

- `E<command>` — error, offending command echoed | ❓ spec only — not observed
- `W<command>` — write-protected (DIP switch 4) | ❓ spec only — not observed

### Command acknowledgments (regexes, ECMAScript flavor)

```js
SAMPLING_FROM_MASK         = /^VF$/        // ✅ V2.5  // wiki/manual says VO; devices emit VF
SAMPLING_FROM_AMBIENT      = /^VN$/        // ✅ V2.5
DATA_TRANSMISSION_DISABLED = /^ZD$/        // ✅ V2.5
DATA_TRANSMISSION_ENABLED  = /^ZE$/        // ✅ V2.5
EXTERNAL_CONTROL           = /^(OK|EJ)$/   // ✅ V2.5 (got OK; EJ not yet observed)
INTERNAL_CONTROL           = /^G$/         // ✅ V2.5
TURN_POWER_OFF             = /^Y$/         // ❓ untested
N95_COMPANION              = /^Q(?<connected>[YN])/i  // ✅ V2.5 (got QN)
SETTINGS_LINE              = /^S.+$/       // ⚠️ overly broad — see settings dump section
```

### Continuous data — external control mode

✅ V2.5, 2026-05-25. One zero-padded concentration per second, 9 chars
+ `\r\n`:

```
000000.00\r\n
006408.45\r\n
```

Regex (the `\d+\.\d+` part is what the device emits; the timestamp
prefix is added by fit-test-console's log layer and **not** by the
device — adapter firmware should not emit it):

```js
PARTICLE_COUNT = /^(?<timestamp>\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d.\d{3}Z)?\s*(?<concentration>\d+\.\d+)\s*/
```

### Continuous data — internal control mode

❓ Spec only — we briefly saw `G` ack but did not capture an extended
internal-mode stream against the real device. The expected shape from
the wiki and fit-test-console:

```
Conc.      0.00 #/cc
Conc.     10200 #/cc
```

Regex:
```js
COUNT_READING = /^\s*Conc\.\s+(?<concentration>[\d.]+)/i
```

### Test progress (internal control mode)

❓ Spec only — no real fit test has been driven yet. Shapes from
the wiki:

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
RGG                          /^R(?<battery>.)(?<pulse>.)$/    // ✅ V2.5 (got RGG)  // G=Good, B=Bad
CS191, CB483, CT236, ...     /^(?<component>C[SBTCLPD])(?<value>.+)$/   // ✅ V2.5 (burst format)
```

### Boot banner (only emitted at power-on)

✅ V2.5, 2026-05-25. **Two firmware-dependent variants observed.**

Modern (V2.5):
```
PORTACOUNT PLUS PROM V2.5\r\n
                          <~6 s silence; device runs warm-up>
Serial Number 44960\r\n
FF pass level = 100\r\n
No. of exers  = 4\r\n
Ambt purge   = 4 sec.\r\n
Ambt sample  = 5 sec.\r\n
Mask purge  = 11 sec.\r\n
Mask sample 1 = 40 sec.\r\n
Mask sample 2 = 40 sec.\r\n
...
DIP switch  = 10111111\r\n
```

Legacy (V1.7, ❓ never seen on real hardware — only described in
wiki / fit-test-console):
```
PORTACOUNT PLUS PROM V1.7
COPYRIGHT(c)1992 TSI INC
ALL RIGHTS RESERVED
Serial Number 17754
…
DIP switch  = 10111111
```

⚠️ Wiki includes `COPYRIGHT(c)NNNN TSI INC` and `ALL RIGHTS RESERVED`
lines. V2.5 firmware omits them entirely — the title line is
followed directly by `Serial Number`. Our `BootBannerCollector`
tolerates both: `copyrightYear` is optional.

⚠️ Wiki implied the banner is emitted promptly on power-up. Reality:
the title line is emitted immediately, but the rest of the banner is
gated on the device's ~60 s warm-up countdown (visible on the
device's display). DIP switch (the terminator) arrives ~44 s after
the title on V2.5.

The banner is **power-on only.** A device that was already running
when the serial port was opened will not emit the banner — only a
power cycle gets you one.

### Settings dump (response to `S`)

✅ V2.5, 2026-05-25. Each line is an `S…` record, no leading echo of
`S` itself. Order observed on V2.5:

```
STPA 00004      ambient purge sec
STA  00005      ambient sample sec
STPM 00011      mask purge sec
STM01 00040     mask sample sec, slot 01
...
STM13 00040     mask sample sec, slot 13         ⚠️ slot 13 exists
SP 01 00100     FF pass level, slot 01
...
SP 12 00000     FF pass level, slot 12 (0 = off)
SS   44960      serial number
SR   00460      runtime, ten-minute units
SD   00111      last service date (0MMYY)
```

Regexes (post-fix; original `STM`/`SP` patterns assumed no whitespace
between fields, which contradicted the format examples — relaxed to
`\s*`):

```js
STPA  000vv      /^STPA\s+(?<duration>\d+)/i                      // ✅ V2.5
STPM  000vv      /^STPM\s+(?<duration>\d+)/i                      // ✅ V2.5
STA   000vv      /^STA\s+(?<duration>\d+)/i                       // ✅ V2.5
STMxx 000vv      /^STM(?<exercise_num>\d\d)\s*(?<duration>\d+)/i  // ✅ V2.5 — note \s* (not \s+)
SP xxvvvvv       /^SP\s+(?<index>\d\d)\s*(?<score>\d+)/i          // ✅ V2.5
SS vvvvv         /^SS\s+(?<serial_number>\d+)/i                   // ✅ V2.5
SR vvvvv         /^SR\s+(?<runtime>\d+)/i    // 10-min units        ✅ V2.5
SD 0MMYY         /^SD\s+0(?<month>\d\d)(?<year>\d\d)/i             // ✅ V2.5
```

⚠️ Wiki claimed `STMxx` is followed immediately by the duration (no
space): `STM(?<exercise_num>\d\d)(?<duration>\d+)`. Real V2.5 emits
`STM01 00040` with a space; we relaxed the regex.

A full simulator response burst is in
`simulator/portacount-8020.ts:SETTINGS_BURST`. Real-device golden
capture: `local/captures/8020/golden-command-walk-V2.5-sn44960.log`.

## Command/response timing & retry

❓ Spec only (sourced from `fit-test-console/src/external-control.ts:118-145`):

- Command retry timeout: **3 seconds** per attempt
- Default max retries: **1** (most call sites), some use 0
- Commands are serialized: never send the next command until the
  previous one has been acknowledged

✅ V2.5, 2026-05-25 measured timings at 1200 baud:

- `J` → `OK` round-trip: ~52 ms
- `R` → `RGG` round-trip: ~54 ms
- `S` → first settings line (`STPA`): ~120 ms
- Full settings burst (31 lines): ~3.2 s
- Inter-line gap during burst: ~105 ms (10 chars/line ≈ 83 ms wire
  time + a few ms device-side gap)
- Particle count cadence: 1 Hz, ±~10 ms jitter

Our default per-command timeout (6 s in `CommandQueue8020`) has
plenty of margin.

## Sync-on-connect sequence (fit-test-console default)

❓ Spec only. When syncOnConnect is enabled, fit-test-console does:

1. Spam `J` (invoke external control) every 1 s until `OK` / `EJ`
   received (timeout 65 s)
2. `ZE`  — enable data transmission
3. `R`   — request runtime status
4. `S`   — request all settings
5. `C`   — request voltage info
6. `B01` × 3 — three short beeps as audible confirmation

✅ V2.5, 2026-05-25: our equivalent sequence (`J → ZE → R → S`)
worked on the first attempt with no `J` retry needed. The 65 s
retry window is overkill for a freshly powered device but probably
matters if `J` is sent during the device's warm-up phase, which we
have not tested.

Our `Portacount8020.connect()` sync uses the same shape minus the
beeps and the `C` voltage poll; both are easy to add as opt-ins.

## Host-driven fit test

✅ V2.5, 2026-05-25, verified end-to-end (real fit on a 3M half-mask
APR with alcohol nebulizer, FF ≈ 185 on first exercise).

The 8020 **has no "start test" command**, and once in external
control (`J`), the device's physical buttons are locked out and its
screen blanks. So a host-driven test is the *only* way to drive a
test under external control — the host fully orchestrates valve
position and timing; the device just streams particle counts at 1 Hz.

### Canonical cycle (per exercise)

```
host                       device
  │  VN                       │     valve → ambient
  │ ───────────────────────►  │
  │  …ambient purge (4 s)…    │     discard samples
  │  …ambient sample (5 s)…   │     ◄── 5× nnnnnn.nn   collect → ambBucket
  │  VF                       │     valve → mask
  │ ───────────────────────►  │
  │  …mask purge (11 s)…      │     discard samples
  │  …mask sample (40 s)…     │     ◄── 40× nnnnnn.nn  collect → maskBucket
```

Per-exercise FF = `mean(ambBucket) / mean(maskBucket)`. Overall FF
across exercises = harmonic mean of per-exercise FFs (OSHA
convention).

Defaults match the device's own configured timings (visible in the
`S` burst as `STPA / STA / STPM / STMnn`). The probe at
`scripts/probe-8020-fittest.ts` reads those or accepts overrides.

### Required setup before driving

1. `J` — invoke external control (must succeed, must wait for `OK`
   or `EJ`).
2. `ZE` — enable continuous data transmission. Without `ZE` the
   device may or may not emit particle counts (the wire-protocol
   doc is unclear; on V2.5 we observed counts streaming without
   explicit `ZE` after a prior session set it, so do not depend on
   `ZE`-off meaning "silent").
3. `VN` — leave the valve on ambient initially as a known starting
   state.

### Measured behavior on real hardware

- Particle count cadence is exactly **1 Hz**, ±~10 ms jitter. So
  N seconds of sampling produces N samples (give or take one).
- Valve switching (`VN`/`VF`) acks within ~50 ms but the *physical*
  valve transition adds the "purge" delay — that's why the purge
  phases exist before sampling.
- A real mask seal gave **mean mask 1.82 #/cc** against **mean
  ambient 336.6 #/cc** = FF ≈ 185 (PASS at level 100).
- An open (no-mask) configuration would put both sides at the same
  ambient level → FF ≈ 1 → FAIL. Worth using as a sanity check.

### Why not observer-style?

Earlier sketch had a `FitTestRunner8020` that watched the line stream
for `NEW TEST PASS = N`, `FF n value`, `Overall FF` events. Those
events *do* arrive on the wire — but only when the device is in
**internal** control (i.e. user pressing physical buttons). Under
external control they never fire, because the device is no longer
the test orchestrator. Both modes are valid; the host-driven runner
is what the webapp uses for remote / unattended tests, and the
observer-style code can remain available for the future "let the
user start the test on the device" path.

## Other observations (not yet integrated into the protocol model)

- **NUL-byte bursts on idle.** ✅ observed V2.5, 2026-05-25. The
  FTDI cable surfaces a stream of `0x00` bytes when the line is idle
  (no terminator within the burst). Almost certainly a cable / driver
  artifact rather than the device emitting real NULs — would need a
  different USB-serial adapter to confirm. Effect on parsing:
  harmless (parser drops NUL-only "lines" as unknown), but it
  pollutes the line log.
- **Banner-rest is gated on the 60 s warm-up.** ✅ V2.5. See banner
  section above. UX implication: any "wait for identity" flow in the
  client needs to be patient — up to ~60 s after open + power-cycle.
- **DIP switch interpretation.** ✅ raw value captured (`10111111` on
  the test device). Per-bit meanings (write protect, baud rate, etc.)
  are claimed in the TSI manual but not cross-referenced here yet.
