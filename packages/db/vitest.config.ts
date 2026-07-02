import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    // src/*.test.ts も対象にする。従来 test/ のみで、src/scenario-*.test.ts や
    // src/faqs.test.ts (24h 窓境界 R1-I2 含む) が CI で実行されていなかった。
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
});
