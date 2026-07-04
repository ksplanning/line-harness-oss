import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  // esbuild automatic JSX runtime so component tests (.test.tsx that render React) transform
  // without a separate vite plugin (plugin-react は vite の major skew を持ち込むため使わない)。
  // No-op for the existing .test.ts (JSX 無し) suites。
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    alias: {
      // Contract test only: import the REAL worker buildMessage flex helpers so the
      // flex-builder round-trip test exercises production code (not a reproduction).
      // message-build.ts is a zero-import, self-contained module, so aliasing it into
      // the web test is clean. The production web bundle never imports this alias.
      '@worker/message-build': path.resolve(__dirname, '../worker/src/utils/message-build.ts'),
      // web の path alias。component テストが broadcast-form の '@/lib/...' 内部 import を解決するのに要る。
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // 既定は node (既存 logic テスト)。React render テストは各ファイル先頭の
    // `// @vitest-environment jsdom` docblock で個別に jsdom を指定する。
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
})
