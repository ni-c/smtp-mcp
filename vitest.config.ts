import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-31 at 95.51 / 88.52 / 95.80 / 96.50, with roughly
      // five points of headroom on functions. Write the missing tests instead
      // of lowering them.
      thresholds: {
        statements: 94,
        branches: 86,
        functions: 90,
        lines: 95,
      },
    },
  },
});
