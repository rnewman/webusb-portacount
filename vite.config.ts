import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: path.resolve(projectRoot, 'webapp'),
  publicDir: false,
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: {
      allow: [projectRoot],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(projectRoot, 'src'),
      '/wasm': path.resolve(projectRoot, 'build'),
    },
  },
  build: {
    outDir: path.resolve(projectRoot, 'dist'),
    emptyOutDir: true,
  },
});
