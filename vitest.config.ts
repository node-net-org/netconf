import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Used by `npm run coverage`, which this package's `check` runs in place of
    // `npm test`; `npm test` stays coverage-free. For the per-file table:
    // npm run coverage -- --coverage.reporter=text
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary'],
      // Floors for the layers that read what the server sends. Each is the
      // level measured on 2026-11-15 (unit tests, integration skipped) minus
      // about 2 points, rounded down, so a regression fails `npm run check` but
      // noise doesn't. Raise them when coverage rises; see docs/net-netconf-design.md.
      //   transport: lines 95.04, branches 88.30, functions 90.61, statements 92.40
      //   xml:       lines 99.35, branches 92.56, functions 100,   statements 96.47
      //   messages:  lines 98.93, branches 87.68, functions 95.88, statements 95.76
      thresholds: {
        'src/transport/**': { lines: 93, branches: 86, functions: 88, statements: 90 },
        'src/xml/**': { lines: 97, branches: 90, functions: 98, statements: 94 },
        'src/messages/**': { lines: 96, branches: 85, functions: 93, statements: 93 },
      },
    },
  },
});
