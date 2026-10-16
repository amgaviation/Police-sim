/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  worker: { format: 'es' },
  build: {
    target: 'esnext',
    sourcemap: true,
    chunkSizeWarningLimit: 5000,
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
