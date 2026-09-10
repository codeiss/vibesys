import { describe, it } from 'vitest';

// 这些用例尚未实现，使用 it.todo 显式标记，避免用「恒真断言」制造虚假通过。
// 覆盖点来自 PRD 需求编号（TOPIC-04、DASH-01/02、D-06/09），实现后请把
// it.todo 改为 it 并补上真实断言。可复用 tests/topic.test.ts 的 HTTP 集成
// 测试骨架（getRequestListener + 临时用户 + afterEach 清理）。

describe('Projects API', () => {
  describe('POST /api/projects', () => {
    it.todo('should create project from topic'); // TOPIC-04, D-06
    it.todo('should reject when exceeding 10 project limit'); // D-08
  });

  describe('GET /api/projects', () => {
    it.todo('should return user projects'); // DASH-01
    it.todo('should include project status'); // DASH-02
  });

  describe('DELETE /api/projects/:id', () => {
    it.todo('should delete project'); // D-09
    it.todo('should reject deletion of other users project'); // Security: 归属校验
  });
});
