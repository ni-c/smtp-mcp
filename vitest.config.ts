import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration suite has its own config and its own command, because it
    // needs a Mailpit in Docker. Excluding it here keeps `npm test` runnable
    // with nothing installed, and keeps the coverage numbers below comparable
    // to what they measured before it existed.
    exclude: [...configDefaults.exclude, 'test/integration/**'],
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
