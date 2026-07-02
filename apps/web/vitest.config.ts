import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  resolve: {
    alias: {
      // Contract test only: import the REAL worker buildMessage flex helpers so the
      // flex-builder round-trip test exercises production code (not a reproduction).
      // message-build.ts is a zero-import, self-contained module, so aliasing it into
      // the web test is clean. The production web bundle never imports this alias.
      '@worker/message-build': path.resolve(__dirname, '../worker/src/utils/message-build.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
