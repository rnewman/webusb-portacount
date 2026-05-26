export type { WireLayer } from './wire-layer';
export { LwipStack } from './lwip-wasm';
export type {
  LwipModule,
  LwipModuleFactory,
  LwipModuleOverrides,
  LwipStackOptions,
  IpOctets,
  TcpHandlers,
  ServerHandlers,
} from './lwip-wasm';
export { VirtualWire } from './virtual-wire';
export { CdcEcmWireLayer } from './cdc-ecm';
export { RndisWireLayer } from './rndis';
export { Portacount, Cmd, parseResponse } from './portacount';
export type {
  DeviceInfo,
  ParsedResponse,
  PortacountTrace,
  FittestExerciseRaw,
} from './portacount';
export { FitTestRunner, FitTestAbortedError } from './fit-test-runner';
export type { FitTestRunArgs } from './fit-test-runner';
export {
  buildNewTempDbXml,
  buildPersonXml,
  buildPollXml,
  buildProtocolXml,
  buildRespiratorXml,
  buildStartXml,
  buildStopXml,
  diffFitTestStatus,
  parseFitTestStatus,
  xmlEscape,
} from './fit-test-protocol';
export type {
  ExerciseResult,
  ExerciseSnapshot,
  ExerciseStatus,
  FitTestAbortReason,
  FitTestMask,
  FitTestPerson,
  FitTestProtocolDef,
  FitTestResult,
  FitTestRunnerCallbacks,
  FitTestRunnerOptions,
  FitTestRunnerState,
  FitTestStartOptions,
  FitTestStatus,
  ProtocolExercise,
} from './fit-test-types';

// ---- PortaCount 8020 (serial / WebSocket) ----
export type { ByteStream } from './byte-stream';
export { Portacount8020 } from './8020/client';
export type {
  ConnectionState8020,
  Portacount8020Options,
  SyncOnConnectOptions,
} from './8020/client';
export { Cmd8020, COMMAND_ACK_OVERRIDES } from './8020/patterns';
export { parseLine, parseSetting } from './8020/parser';
export type { ParsedEvent, ParsedSetting, UnknownLine } from './8020/parser';
export { LineAssembler } from './8020/line-assembler';
export {
  CommandQueue8020,
  CommandError8020,
  CommandTimeoutError,
  CommandAbortedError,
} from './8020/command-queue';
export type { CommandOptions } from './8020/command-queue';
export { reduce as reduce8020, emptyState as emptyState8020 } from './8020/state';
export { BootBannerCollector, applyBannerEvent, emptyIdentity } from './8020/boot-banner';
export type { DeviceIdentity8020, BootBannerListener } from './8020/boot-banner';
export type {
  Portacount8020State,
  ControlSource,
  SampleSource,
  DataTxState,
  DeviceSettings8020,
  RuntimeStatus8020,
  FitTestProgress8020,
  ExerciseRecord8020,
} from './8020/state';
export { FitTestRunner8020 } from './8020/fit-test-runner';
export type {
  FitTestResult8020,
  FitTestRunnerCallbacks8020,
  FitTestRunner8020State,
  ExerciseResult8020,
  AmbientMaskSample,
} from './8020/fit-test-runner';
export {
  runHostDrivenFitTest,
  FitTestAbortedError8020,
  DEFAULT_CYCLE,
} from './8020/host-driven-fit-test';
export type {
  HostDrivenFitTestOptions,
  HostDrivenFitTestCallbacks,
  FitTestPhase8020,
  FitTestPhaseInfo,
  FitTestSample,
} from './8020/host-driven-fit-test';
export { WebSerialByteStream } from './serial/web-serial';
export type { WebSerialByteStreamOptions, WebSerialPortLike, WebSerialOpenParams } from './serial/web-serial';
export { WebSocketByteStream } from './serial/web-socket';
export type { WebSocketByteStreamOptions } from './serial/web-socket';
