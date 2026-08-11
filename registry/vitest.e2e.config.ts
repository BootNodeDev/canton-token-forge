import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/e2e/**/*.test.ts'],
    // A live round trip costs orders of magnitude more than the stubbed
    // suite, and each test allocates parties and creates contracts first.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Every file drives the same participant, so concurrent files would race
    // on party allocation and on each other's ledger-end snapshots.
    fileParallelism: false,
  },
})
