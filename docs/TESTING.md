# Testing strategy

How the test suite mirrors the stack, and how a single `command()`
call traverses every layer between application code and the USB bulk
endpoint.

## Control flow: a single `command()` round-trip

```
app code                    pc.command('<MAIN>…</MAIN>')
                                │
src/portacount.ts               │ exchange(payload, timeoutMs)
                                │   ├ assembler.reset()
                                │   ├ pendingResponse = { resolve, reject, timer }
                                │   └ stack.tcpWrite(payload)
                                ▼
src/lwip-wasm.ts            tcpWrite copies bytes into the wasm heap
                                │ calls Module._lwip_wasm_tcp_write(len)
                                ▼
csrc/glue.c                 tcp_write + tcp_output, returns ERR_OK
                                │
                                │ lwIP segments, ARPs if needed,
                                │ calls webusb_linkoutput(pbuf)
                                ▼
csrc/glue.c                 js_on_output_frame(buf, len)
                                │ (EM_JS bridge → JS callback)
                                ▼
src/lwip-wasm.ts            onOutputFrame → user callback
                                ▼
src/rndis.ts                wire.sendFrame(frame)
                                │ prepends RNDIS PACKET_MSG header
                                ▼
WebUSB                      device.transferOut(bulkOutEp, packet)

  …network round-trip…

WebUSB                      device.transferIn(bulkInEp) resolves
                                ▼
src/rndis.ts                strips PACKET_MSG header,
                            (filters our-own-MAC loopback frames)
                                ▼
src/lwip-wasm.ts            stack.injectFrame(frame)
                                │ copies into the wasm heap,
                                │ calls Module._lwip_wasm_inject_frame(len)
                                ▼
csrc/glue.c                 ethernet_input → IP → TCP → tcp_recv
                                │ calls client_recv_cb → js_on_tcp_recv
                                ▼
src/lwip-wasm.ts            onTcpRecv → setTcpHandlers().onData
                                ▼
src/portacount.ts           onTcpData(data)
                                │ assembler.push(data) → complete?
                                │   yes → pendingResponse.resolve(bytes)
                                │   no  → arm 200 ms quiescence timer
                                ▼
app code                    `command()` Promise resolves with the response text
```

Two boundaries are worth naming explicitly:

- **The C / JS boundary** crosses through Emscripten's `EM_JS` for
  callbacks and exported C functions for calls down. The wasm side
  copies into / from a single shared heap buffer per direction
  (`output_frame_buf`, `inject_frame_buf`, `tcp_write_buf`,
  `tcp_recv_buf`) — there's no per-frame malloc on either side.
- **The USB boundary** is the only place where we can sniff
  ground-truth bytes (pcap on WebUSB transfers, or USBPcap on
  Windows). Everything above can be reasoned about; below this we're
  at the mercy of the device firmware.

## Test pyramid

The test pyramid mirrors the layer stack:

```
                  ▲  fewer, slower, less reliable
                  │
  hardware ──┐    │   scripts/probe-handshake.ts (manual)
             │    │
  integration ───►│   test/echo.test.ts
                  │   test/portacount-integration.test.ts
                  │
  orchestration ─►│   test/portacount-orchestration.test.ts
                  │
  pure ──────────►│   test/response-assembler.test.ts
                  │   test/portacount-parser.test.ts
                  ▼  many, fast, deterministic
```

The split inside each layer is the load-bearing idea. **Pure modules
are tested as pure functions**: deterministic input → deterministic
output, no fake timers, no stubs, no microtask juggling.
**Orchestration modules are tested with the layer below stubbed at
its narrowest interface**, with synchronisation on observable events
rather than on microtask depth.

### Pure: example

`ResponseAssembler.push(bytes('one ')) → {kind:'incomplete'}`. One
line in, one line of assertion. No `await`, no `vi.useFakeTimers()`.
If the framing rule changes — say the device learns to accept `\r\n`
— the new test is one more line.

### Orchestration: example

`Portacount.readRuntime` traverses three async steps (`openTcp →
exchange → closeTcp`). The test stubs `LwipStack` and uses
`Channel<T>` to wait on the **actual** events (`tcpConnect`,
`tcpWrite`, `tcpClose`) rather than guessing how many microtasks to
drain.

The `Channel<T>` is a buffered async queue:

- producer: `push(value)` — wakes a waiter if any, else queues.
- consumer: `next()` → Promise that resolves with the next value (or
  immediately if one is already queued).

This is the principled answer to a class of test-time races. The wrong
answer (and we tried it) is `await flush(); for (let i = 0; i < 10;
i++) await Promise.resolve();` — that's a fixed-count microtask drain,
which silently breaks the moment you add another `await` to the
production code.

### Integration: example

`test/echo.test.ts` runs two `LwipStack` instances connected by an
in-process `VirtualWire`. Stack B runs a C-side echo server on port 7,
Stack A connects and exchanges bytes. No USB, no real timers. This is
where real lwIP runs through real ARP, real TCP, real segmentation —
everything except the wire.

`test/portacount-integration.test.ts` builds on the same idea:
`test/fake-portacount.ts` is a server-side fake that listens on the
two real TCP ports, recognises the XML commands the device expects,
and replies with canned responses. The full `Portacount` client class
runs against it end-to-end through lwIP and the virtual wire.

### Hardware

`scripts/probe-handshake.ts` is the canonical hardware-in-the-loop
"test", except it's a probe, not an assertion. The artefact it
produces (a journal entry + a pcap in `captures/`) is the assertion:
"the device responded this way today."

## When this strategy breaks down

A few honest caveats.

- **lwIP itself is untested by us.** We rely on lwIP's own test suite
  and on the echo test to catch gross breakage in our glue. A subtle
  RFC corner case in TCP handling — say, a bug in window scaling —
  we would not catch.

- **The WebUSB / `usb`-package boundary is shimmed but not identical.**
  The `usb` package's WebUSB shim is close-but-not-exact to a real
  browser's behaviour. Expect a small backlog of "shim accepted this,
  browser doesn't" issues on first contact with a real device in
  Chromium.

- **Stubbing at the wrong interface is worse than not stubbing.** The
  framing tests *don't* stub `LwipStack` — they don't touch it at
  all, because `ResponseAssembler` doesn't need it. If we'd written a
  stub `LwipStack` for the framing tests, we'd be testing the stub
  instead of the framing logic. Picking the narrowest possible
  boundary for each test is what keeps the tests honest.

- **The orchestration tests verify behaviour, not correctness.** They
  prove "given these events in this order, the Portacount state
  machine resolves the promise with this value." They cannot prove
  "the state machine handles every possible event ordering
  correctly." That's what fuzz tests would buy, and we don't have any
  yet.
