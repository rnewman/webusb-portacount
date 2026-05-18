#!/usr/bin/env node
// Fail loudly if the wasm artifacts aren't present at pack time.
// We don't try to build them here — emsdk isn't available in a clean
// `npm install`, and we don't want to silently ship a broken tarball.

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const required = ['build/lwip.js', 'build/lwip.wasm'];
const missing = required.filter((p) => !existsSync(resolve(root, p)));

if (missing.length) {
  console.error(`check-wasm: missing artifacts: ${missing.join(', ')}`);
  console.error(`check-wasm: run 'npm run build:wasm' (requires emsdk activated) before packing.`);
  process.exit(1);
}
