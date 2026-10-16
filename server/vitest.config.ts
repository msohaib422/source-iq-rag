import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    // The embedding model is ~128 MB of ONNX weights; give suites room.
    testTimeout: 180_000,
    hookTimeout: 300_000,
    // ONNX Runtime + Mongoose are not safe to share across parallel forks.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/types/**'],
    },
  },
});