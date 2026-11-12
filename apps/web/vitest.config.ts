import path from 'node:path';
import { defineConfig } from 'vitest/config';

// JSX is compiled by Vite's built-in esbuild (automatic runtime); the React plugin is not
// needed for tests and would pull in a second, rolldown-based Vite.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
    css: false,
  },
});
