import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/test/**/*.test.js'],
    // The schema-parity suite boots both the original app and the port for
    // each case, and drives real 700ms accept delays.
    testTimeout: 30000
  }
});
