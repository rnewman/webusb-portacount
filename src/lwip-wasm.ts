/**
 * Typed wrapper around the Emscripten-compiled lwIP Wasm module.
 */

export type IpOctets = [number, number, number, number];

export type Addressing = 'static' | 'autoip' | 'dhcp';

const ADDRESSING_CODE: Record<Addressing, number> = {
  static: 0,
  autoip: 1,
  dhcp: 2,
};

export interface LwipModule {
  _lwip_wasm_init(
    macPtr: number, macLen: number,
    addressing: number,
    ipA: number, ipB: number, ipC: number, ipD: number,
    nmA: number, nmB: number, nmC: number, nmD: number,
  ): number;
  _lwip_wasm_inject_frame(len: number): number;
  _lwip_wasm_check_timeouts(): void;
  _lwip_wasm_get_frame_buf(): number;
  _lwip_wasm_get_inject_buf(): number;
  _lwip_wasm_get_ip(): number;
  _lwip_wasm_get_gateway(): number;
  _lwip_wasm_get_netmask(): number;
  _lwip_wasm_echo_server_start(port: number): number;
  _lwip_wasm_tcp_connect(
    ipA: number, ipB: number, ipC: number, ipD: number, port: number,
  ): number;
  _lwip_wasm_tcp_write(len: number): number;
  _lwip_wasm_tcp_close(): number;
  _lwip_wasm_get_tcp_write_buf(): number;
  _lwip_wasm_server_listen(port: number): number;
  _lwip_wasm_server_write(connId: number, len: number): number;
  _lwip_wasm_server_close(connId: number): number;
  _lwip_wasm_get_server_write_buf(): number;
  _malloc(size: number): number;
  _free(ptr: number): void;
  HEAPU8: Uint8Array;

  // Custom callbacks set by TS before init
  _onOutputFrame?: (dataPtr: number, len: number) => void;
  _onIpStatus?: (ip: number) => void;
  _onTcpConnected?: () => void;
  _onTcpRecv?: (dataPtr: number, len: number) => void;
  _onTcpClosed?: () => void;
  _onTcpError?: (err: number) => void;
  _onServerAccept?: (connId: number, port: number) => void;
  _onServerRecv?: (connId: number, dataPtr: number, len: number) => void;
  _onServerClosed?: (connId: number) => void;
}

export interface TcpHandlers {
  onConnected?: () => void;
  onData?: (data: Uint8Array) => void;
  onClosed?: () => void;
  onError?: (err: number) => void;
}

/**
 * Handlers for a generic TS-driven TCP server (see {@link LwipStack.serverListen}).
 * Each accepted connection gets a small integer `connId` — pass it back to
 * serverWrite/serverClose to address that specific peer.
 */
export interface ServerHandlers {
  onAccept?: (connId: number, port: number) => void;
  onData?: (connId: number, data: Uint8Array) => void;
  onClosed?: (connId: number) => void;
}

export interface LwipStackOptions {
  /**
   * How to acquire an address. Defaults to 'static' if `ip` is provided
   * and non-zero, otherwise 'autoip'. Pass 'dhcp' to act as a DHCP
   * client (used when the device runs a DHCP server, e.g. RNDIS).
   */
  addressing?: Addressing;
  /** Static IP octets. Required when addressing == 'static'. */
  ip?: IpOctets;
  /** Netmask octets. Required when addressing == 'static'. */
  netmask?: IpOctets;
  /** Fires when the netif IP changes (e.g. DHCP/AutoIP completes). */
  onIpStatus?: (ip: string, gateway: string, netmask: string) => void;
}

type CreateLwipModule = (overrides?: Partial<LwipModule>) => Promise<LwipModule>;

function formatIp(ipU32: number): string {
  return `${ipU32 & 0xff}.${(ipU32 >> 8) & 0xff}.${(ipU32 >> 16) & 0xff}.${(ipU32 >> 24) & 0xff}`;
}

function ipToOctets(ipU32: number): IpOctets {
  return [ipU32 & 0xff, (ipU32 >> 8) & 0xff, (ipU32 >> 16) & 0xff, (ipU32 >> 24) & 0xff];
}

/**
 * Manages the lwIP Wasm module lifecycle and provides a typed API
 * for Ethernet frame I/O and TCP operations.
 */
export class LwipStack {
  private module: LwipModule;
  private injectBufPtr: number;
  private tcpWriteBufPtr: number;
  private serverWriteBufPtr: number;
  private timerHandle: ReturnType<typeof setInterval> | null = null;
  private tcpHandlers: TcpHandlers = {};
  private serverHandlers: ServerHandlers = {};

  private constructor(
    module: LwipModule,
    injectBufPtr: number,
    tcpWriteBufPtr: number,
    serverWriteBufPtr: number,
  ) {
    this.module = module;
    this.injectBufPtr = injectBufPtr;
    this.tcpWriteBufPtr = tcpWriteBufPtr;
    this.serverWriteBufPtr = serverWriteBufPtr;
  }

  /**
   * Load and initialize the lwIP Wasm module.
   */
  static async create(
    wasmUrl: string,
    mac: Uint8Array,
    onOutputFrame: (frame: Uint8Array) => void,
    options?: LwipStackOptions,
  ): Promise<LwipStack> {
    const { default: createModule }: { default: CreateLwipModule } = await import(
      /* @vite-ignore */ wasmUrl
    );

    let mod: LwipModule;
    let stackRef: LwipStack;

    const module = await createModule({
      _onOutputFrame: (dataPtr: number, len: number) => {
        const frame = new Uint8Array(mod.HEAPU8.buffer, dataPtr, len).slice();
        onOutputFrame(frame);
      },
      _onIpStatus: (ip: number) => {
        if (!options?.onIpStatus) return;
        const gw = mod._lwip_wasm_get_gateway();
        const nm = mod._lwip_wasm_get_netmask();
        options.onIpStatus(formatIp(ip), formatIp(gw), formatIp(nm));
      },
      _onTcpConnected: () => stackRef.tcpHandlers.onConnected?.(),
      _onTcpRecv: (dataPtr: number, len: number) => {
        const data = new Uint8Array(mod.HEAPU8.buffer, dataPtr, len).slice();
        stackRef.tcpHandlers.onData?.(data);
      },
      _onTcpClosed: () => stackRef.tcpHandlers.onClosed?.(),
      _onTcpError: (err: number) => stackRef.tcpHandlers.onError?.(err),
      _onServerAccept: (connId: number, port: number) => {
        stackRef.serverHandlers.onAccept?.(connId, port);
      },
      _onServerRecv: (connId: number, dataPtr: number, len: number) => {
        const data = new Uint8Array(mod.HEAPU8.buffer, dataPtr, len).slice();
        stackRef.serverHandlers.onData?.(connId, data);
      },
      _onServerClosed: (connId: number) => {
        stackRef.serverHandlers.onClosed?.(connId);
      },
    });
    mod = module;

    // Write MAC into the inject buffer (reused temporarily)
    const injectBufPtr = module._lwip_wasm_get_inject_buf();
    module.HEAPU8.set(mac, injectBufPtr);

    // Decide addressing mode
    const ip = options?.ip;
    const nm = options?.netmask ?? [255, 255, 0, 0];
    let addressing: Addressing;
    if (options?.addressing) {
      addressing = options.addressing;
    } else if (ip && ip.some((b) => b !== 0)) {
      addressing = 'static';
    } else {
      addressing = 'autoip';
    }
    const ipArg = ip ?? [0, 0, 0, 0];

    const result = module._lwip_wasm_init(
      injectBufPtr, 6,
      ADDRESSING_CODE[addressing],
      ipArg[0], ipArg[1], ipArg[2], ipArg[3],
      nm[0], nm[1], nm[2], nm[3],
    );
    if (result !== 0) {
      throw new Error(`lwip_wasm_init failed with code ${result}`);
    }

    const tcpWriteBufPtr = module._lwip_wasm_get_tcp_write_buf();
    const serverWriteBufPtr = module._lwip_wasm_get_server_write_buf();
    stackRef = new LwipStack(module, injectBufPtr, tcpWriteBufPtr, serverWriteBufPtr);

    // Drive lwIP timeouts. DHCP needs prompt timer service for retries.
    stackRef.timerHandle = setInterval(() => {
      module._lwip_wasm_check_timeouts();
    }, 100);

    return stackRef;
  }

  /** Inject a raw Ethernet frame into the lwIP stack. */
  injectFrame(frame: Uint8Array): void {
    if (frame.byteLength > 1600) {
      throw new Error(`Frame too large: ${frame.byteLength}`);
    }
    this.module.HEAPU8.set(frame, this.injectBufPtr);
    this.module._lwip_wasm_inject_frame(frame.byteLength);
  }

  /** Current netif IPv4 address as octets. [0,0,0,0] until acquired. */
  get ip(): IpOctets { return ipToOctets(this.module._lwip_wasm_get_ip()); }
  /** Current netif gateway. [0,0,0,0] until acquired (e.g. via DHCP). */
  get gateway(): IpOctets { return ipToOctets(this.module._lwip_wasm_get_gateway()); }
  /** Current netif netmask. */
  get netmask(): IpOctets { return ipToOctets(this.module._lwip_wasm_get_netmask()); }

  /** Install handlers for the single active TCP client connection. */
  setTcpHandlers(handlers: TcpHandlers): void {
    this.tcpHandlers = handlers;
  }

  /** Start a TCP echo server on the given port (test infrastructure). */
  startEchoServer(port: number): void {
    const result = this.module._lwip_wasm_echo_server_start(port);
    if (result !== 0) {
      throw new Error(`echo server start failed with code ${result}`);
    }
  }

  /** Initiate a TCP connection to the given IP and port. */
  tcpConnect(ip: IpOctets, port: number): void {
    const result = this.module._lwip_wasm_tcp_connect(ip[0], ip[1], ip[2], ip[3], port);
    if (result !== 0) {
      throw new Error(`tcp_connect failed with code ${result}`);
    }
  }

  /** Write data to the active TCP connection. */
  tcpWrite(data: Uint8Array): void {
    if (data.byteLength > 1600) {
      throw new Error(`Data too large: ${data.byteLength}`);
    }
    this.module.HEAPU8.set(data, this.tcpWriteBufPtr);
    const result = this.module._lwip_wasm_tcp_write(data.byteLength);
    if (result !== 0) {
      throw new Error(`tcp_write failed with code ${result}`);
    }
  }

  /** Close the active TCP connection. */
  tcpClose(): void {
    this.module._lwip_wasm_tcp_close();
  }

  /**
   * Install handlers for the JS-driven TCP server (see {@link serverListen}).
   * Replaces any previously-installed server handlers.
   */
  setServerHandlers(handlers: ServerHandlers): void {
    this.serverHandlers = handlers;
  }

  /**
   * Start listening on `port` for inbound TCP connections. Each accepted
   * connection fires {@link ServerHandlers.onAccept} with a small integer
   * `connId`; pass that back to {@link serverWrite} / {@link serverClose}
   * to address that specific peer.
   *
   * Used by test fakes; for production servers prefer {@link startEchoServer}
   * or extend csrc/glue.c with a dedicated C-side handler.
   */
  serverListen(port: number): void {
    const result = this.module._lwip_wasm_server_listen(port);
    if (result !== 0) {
      throw new Error(`server_listen(${port}) failed with code ${result}`);
    }
  }

  /** Write data to an accepted server connection. */
  serverWrite(connId: number, data: Uint8Array): void {
    if (data.byteLength > 1600) {
      throw new Error(`Data too large: ${data.byteLength}`);
    }
    this.module.HEAPU8.set(data, this.serverWriteBufPtr);
    const result = this.module._lwip_wasm_server_write(connId, data.byteLength);
    if (result !== 0) {
      throw new Error(`server_write(conn=${connId}) failed with code ${result}`);
    }
  }

  /** Close an accepted server connection. */
  serverClose(connId: number): void {
    this.module._lwip_wasm_server_close(connId);
  }

  /** Shut down the stack and free resources. */
  destroy(): void {
    if (this.timerHandle !== null) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
