import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // src/*.test.ts も対象にする。従来 test/ のみで、src/scenario-*.test.ts や
    // src/faqs.test.ts (24h 窓境界 R1-I2 含む) が CI で実行されていなかった。
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    // Vitest 3 の fork プール並列度では、subprocess を起こす invariant テスト
    // (bootstrap.test.ts の `generate-bootstrap --check` は execFileSync('node', ...) で
    // 実測 5.75-8.55s) が既定 5000ms を超えて timeout する。apps/worker/vitest.config.ts
    // と同一の margin 拡大 (assert 不変・実行時間のみ)。
    testTimeout: 30000,
  },
});
