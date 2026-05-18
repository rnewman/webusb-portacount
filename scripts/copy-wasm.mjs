#!/usr/bin/env node
// Copy build/lwip.js + build/lwip.wasm into dist/wasm/ and emit a
// hand-rolled type declaration so consumers can do:
//   import createLwipModule from 'webusb-portacount/wasm';

import { copyFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDir = resolve(root, 'build');
const outDir = resolve(root, 'dist', 'wasm');

const sources = [
  ['lwip.js', 'lwip.js'],
  ['lwip.wasm', 'lwip.wasm'],
];

for (const [src] of sources) {
  if (!existsSync(resolve(buildDir, src))) {
    console.error(`copy-wasm: missing build/${src} — run 'npm run build:wasm' first`);
    process.exit(1);
  }
}

mkdirSync(outDir, { recursive: true });
for (const [src, dst] of sources) {
  copyFileSync(resolve(buildDir, src), resolve(outDir, dst));
}

const dts = `import type { LwipModuleFactory } from '../lwip-wasm.js';

declare const createLwipModule: LwipModuleFactory;
export default createLwipModule;
`;
writeFileSync(resolve(outDir, 'lwip.d.ts'), dts);

console.log(`copy-wasm: wrote ${outDir}/{lwip.js,lwip.wasm,lwip.d.ts}`);
