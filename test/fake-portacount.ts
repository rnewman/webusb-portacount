/**
 * Test-side fake of the Portacount 8030 device. Listens on the same two
 * TCP ports the real device uses, recognises the XML commands the
 * device expects, and replies with canned responses parameterised by
 * a fixture object.
 *
 * Lives in test/ rather than src/ — this is a test fake, not a piece
 * of production code.
 */

import { ResponseAssembler } from '../src/response-assembler';
import type { LwipStack } from '../src/lwip-wasm';

const utf8 = new TextEncoder();
const dec = new TextDecoder();

const RUNTIME_PORT = 3602;
const PROTOCOL_PORT = 3603;
const TERMINATOR = '\r\r';

export interface DeviceFixture {
  serialNumber: string;
  modelNumber: string;
  buildString: string;
  runtimeSeconds: number;
  realtime: {
    ambConc: number;
    maskConc: number;
    fitFactor: number;
    message?: string;
    status?: string;
    n95Enable?: boolean;
    countMode?: string;
  };
}

export const DEFAULT_FIXTURE: DeviceFixture = {
  serialNumber: 'FAKE0001',
  modelNumber: '8030',
  buildString: '0.0.0-fake',
  runtimeSeconds: 12345,
  realtime: {
    ambConc: 2500,
    maskConc: 25,
    fitFactor: 100,
    message: 'OK',
    status: 'READY',
    n95Enable: false,
    countMode: 'N99',
  },
};

interface ConnState {
  port: number;
  assembler: ResponseAssembler;
}

/**
 * Drives an LwipStack as a fake Portacount. Pass in the *device* stack
 * (the one with the device IP). After construction, the host can connect
 * to PROTOCOL_PORT / RUNTIME_PORT and walk the handshake against this
 * fake.
 *
 * Tracks per-session lock state (UNLOCK / REMOTE) so the LOCK READ →
 * LOCK WRITE REMOTE branch in Portacount.connect actually exercises.
 */
export class FakePortacount {
  private stack: LwipStack;
  private fixture: DeviceFixture;
  private conns = new Map<number, ConnState>();
  /** Lock state is per-device, not per-connection. */
  private lockState: 'UNLOCK' | 'REMOTE' = 'UNLOCK';
  /** Commands seen this session, for assertions in tests. */
  readonly received: string[] = [];

  constructor(stack: LwipStack, fixture: DeviceFixture = DEFAULT_FIXTURE) {
    this.stack = stack;
    this.fixture = fixture;
    this.stack.setServerHandlers({
      onAccept: (id, port) => this.onAccept(id, port),
      onData: (id, data) => this.onData(id, data),
      onClosed: (id) => this.onClosed(id),
    });
    this.stack.serverListen(RUNTIME_PORT);
    this.stack.serverListen(PROTOCOL_PORT);
  }

  /** Force the lock state — useful for testing the LOCK-already-REMOTE branch. */
  setLockState(state: 'UNLOCK' | 'REMOTE'): void {
    this.lockState = state;
  }

  private onAccept(connId: number, port: number): void {
    this.conns.set(connId, { port, assembler: new ResponseAssembler() });
  }

  private onClosed(connId: number): void {
    this.conns.delete(connId);
  }

  private onData(connId: number, data: Uint8Array): void {
    const conn = this.conns.get(connId);
    if (!conn) return;

    if (conn.port === RUNTIME_PORT) {
      this.handleRuntime(connId, data);
      return;
    }
    // PROTOCOL_PORT: accumulate via the assembler; respond to each
    // complete command. (The real device's framing matches our client's,
    // so the assembler is the right tool here too.)
    const result = conn.assembler.push(data);
    if (result.kind === 'complete') {
      const text = dec.decode(result.bytes);
      // Strip the \r\r terminator before dispatch.
      const xml = text.endsWith(TERMINATOR) ? text.slice(0, -TERMINATOR.length) : text;
      this.received.push(xml);
      const reply = this.handleProtocol(xml);
      if (reply !== null) {
        this.stack.serverWrite(connId, utf8.encode(reply + TERMINATOR));
      }
    }
  }

  // ---- 3602: runtime probe ----

  private handleRuntime(connId: number, data: Uint8Array): void {
    const req = dec.decode(data).trim();
    if (req !== 'RSRTLSVC') {
      // Real device probably ignores; we just close.
      this.stack.serverClose(connId);
      return;
    }
    // Device sends an ASCII integer with no \r\r terminator on this
    // endpoint, then closes. We mirror that.
    this.stack.serverWrite(connId, utf8.encode(String(this.fixture.runtimeSeconds)));
    this.stack.serverClose(connId);
  }

  // ---- 3603: XML protocol ----

  /** Returns the XML reply (without the \r\r terminator) or null to send nothing. */
  private handleProtocol(xml: string): string | null {
    const f = this.fixture;

    if (xml.includes('<SYSTEM><ALL/>')) {
      return [
        '<MAIN><SYSTEM>',
        `<SERIAL_NUMBER>${f.serialNumber}</SERIAL_NUMBER>`,
        `<MODEL_NUMBER>${f.modelNumber}</MODEL_NUMBER>`,
        `<BUILD_STRING>${f.buildString}</BUILD_STRING>`,
        '</SYSTEM></MAIN>',
      ].join('');
    }

    if (xml.includes('<FITPRO_STRING COMMAND="WRITE">')) {
      return '<MAIN><SYSTEM><FITPRO_STRING>OK</FITPRO_STRING></SYSTEM></MAIN>';
    }

    if (xml.includes('<LOCK COMMAND="READ"')) {
      return `<MAIN><SYSTEM><LOCK>${this.lockState}</LOCK></SYSTEM></MAIN>`;
    }

    const lockWrite = /<LOCK COMMAND="WRITE">([^<]+)<\/LOCK>/.exec(xml);
    if (lockWrite) {
      const v = lockWrite[1];
      if (v === 'REMOTE' || v === 'UNLOCK') {
        this.lockState = v;
      }
      // KEEPALIVE doesn't change state, just acks.
      return `<MAIN><SYSTEM><LOCK>${this.lockState}</LOCK></SYSTEM></MAIN>`;
    }

    if (xml.includes('<UNIT_NUMBER COMMAND="WRITE">')) {
      return '<MAIN><SYSTEM><UNIT_NUMBER>OK</UNIT_NUMBER></SYSTEM></MAIN>';
    }

    if (xml.includes('<REALTIME><ALL/>') || xml.includes('<REALTIME><START/>')) {
      const r = f.realtime;
      return [
        '<MAIN><REALTIME>',
        `<AMB_CONC>${r.ambConc}</AMB_CONC>`,
        `<MASK_CONC>${r.maskConc}</MASK_CONC>`,
        `<FITFACTOR>${r.fitFactor}</FITFACTOR>`,
        r.message ? `<MESSAGE>${r.message}</MESSAGE>` : '',
        r.status ? `<STATUS>${r.status}</STATUS>` : '',
        r.n95Enable !== undefined ? `<N95_ENABLE>${r.n95Enable ? 1 : 0}</N95_ENABLE>` : '',
        r.countMode ? `<COUNT_MODE>${r.countMode}</COUNT_MODE>` : '',
        '</REALTIME></MAIN>',
      ].join('');
    }

    if (xml.includes('<REALTIME><STOP/>')) {
      return '<MAIN><REALTIME><STOP>OK</STOP></REALTIME></MAIN>';
    }

    // Unknown command — reply with an error frame so the test can see it.
    return '<MAIN><ERROR>unknown command</ERROR></MAIN>';
  }
}
