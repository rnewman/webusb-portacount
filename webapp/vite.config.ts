import { defineConfig } from 'vite';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function gitSha(): string {
  try {
    const sha = execSync('git rev-parse --short HEAD', {
      cwd: here,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    const dirty = execSync('git status --porcelain', {
      cwd: here,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim().length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root: here,
  publicDir: false,
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      // Allow Vite to serve files from the parent (the linked library
      // package, including dist/wasm/lwip.wasm).
      allow: [path.resolve(here, '..')],
    },
  },
  build: {
    outDir: path.resolve(here, 'dist'),
    emptyOutDir: true,
  },
  plugins: [
    {
      name: 'inject-git-sha',
      transformIndexHtml: {
        order: 'pre',
        handler(html) {
          return html.replace(/%GIT_SHA%/g, gitSha());
        },
      },
    },
  ],
});
