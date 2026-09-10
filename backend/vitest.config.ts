import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{js,ts}'],
    // 集成测试共用同一个 SQLite 文件，并行执行会触发 SQLITE_BUSY，
    // 因此关闭文件级并行，串行执行各测试文件。
    fileParallelism: false,
    // 集成测试要建数据 + bcrypt 哈希 + 真实 HTTP 往返，默认 5s 偏紧。
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
    },
  },
});
