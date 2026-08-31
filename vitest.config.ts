import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Entry point: only wires config and server to the stdio transport and
      // exits the process; not reachable from unit tests.
      exclude: ['src/index.ts'],
      // Measured on 2026-08-31 at 95.99 / 88.90 / 97.10 / 96.96, after the
      // security audit, with roughly five points of headroom on functions.
      // Write the missing tests instead of lowering them.
      thresholds: {
        statements: 95,
        branches: 87,
        functions: 92,
        lines: 96,
      },
    },
  },
});
