import { configDefaults, defineConfig } from 'vitest/config'

// The end-to-end suite needs a participant, so it is excluded here and asked
// for explicitly through `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/e2e/**'],
  },
})
