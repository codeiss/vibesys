import { describe, it } from 'vitest';

// 这些用例尚未实现，使用 it.todo 显式标记，避免用「恒真断言」制造虚假通过。
// 覆盖点来自 PRD 需求编号（DOC-01~06、D-10~13），实现后请把 it.todo 改为 it
// 并补上真实断言。可复用 tests/topic.test.ts 的 HTTP 集成测试骨架
// （getRequestListener + 临时用户 + afterEach 清理）。

describe('Documents API', () => {
  describe('GET /api/documents/:projectId', () => {
    it.todo('should return all documents for user project'); // DOC-01, DOC-02, DOC-03
    it.todo('should include tech stack from topic'); // DOC-06
    it.todo('should reject access to other users documents'); // Security: IDOR 防护
  });

  describe('PUT /api/documents/:id', () => {
    it.todo('should update document content'); // DOC-05: 实时保存 (D-12)
    it.todo('should reject large content over 100KB'); // DOS 防护
    it.todo('should reject update for other users documents'); // Security: 通过 project.userId 校验归属
  });

  describe('POST /api/documents', () => {
    it.todo('should create empty document'); // 惰性创建
    it.todo('should handle existing document gracefully'); // @@unique([projectId, docType])
    it.todo('should validate docType enum'); // DocType 取值校验
  });
});
