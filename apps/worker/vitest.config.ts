import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // @line-crm/line-sdk has main=dist/index.js but dist may not exist in
      // the worktree; point Vitest directly at the TS sources so tests resolve
      // without a build step.
      '@line-crm/line-sdk': path.resolve(__dirname, '../../packages/line-sdk/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    // Vitest 3 の fork プール並列度では、subprocess を起こす invariant テスト
    // (D-3 の `generate-bootstrap --check` は execFileSync('node', ...) で ~7s)
    // が既定 5000ms を超えて timeout する。assert は不変・実行時間の margin のみ拡大。
    testTimeout: 30000,
  },
});
