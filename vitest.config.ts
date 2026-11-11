import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/tests/**/*.test.ts', 'tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});