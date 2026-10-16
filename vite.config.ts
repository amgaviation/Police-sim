/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    sourcemap: true,
    // rapier3d-compat inlines its WASM as base64, so its own chunk is ~4.3 MB; the
    // limit is set for that chunk alone. App code and three get separate chunks, so
    // app growth cannot push a chunk past the limit unnoticed.
    chunkSizeWarningLimit: 5000,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge[\\/]/ },
            { name: 'three', test: /node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
