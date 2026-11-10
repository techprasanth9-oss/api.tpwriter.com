import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Applied to process.env before any test file (and so src/env.ts) loads.
    // dotenv never overrides variables that are already set, and pointing it
    // at a non-existent file means the real .env (live Atlas URI) is never
    // even read during tests. The URI below is a placeholder: the test setup
    // connects Mongoose to an in-memory replica set instead.
    env: {
      NODE_ENV: "test",
      DOTENV_CONFIG_PATH: "/nonexistent/tp-writer-api-test.env",
      MONGODB_URI: "mongodb://test-placeholder.invalid/never-used",
      JWT_SECRET: "test-secret-test-secret-test-secret-0123456789",
      CORS_ORIGINS: "http://localhost:3000",
    },
    setupFiles: ["src/test/setup.ts"],
    // Starting mongod can be slow on a cold CI runner.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
