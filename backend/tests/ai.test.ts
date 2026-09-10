import { describe, it } from 'vitest';

// 这些用例尚未实现，使用 it.todo 显式标记，避免用「恒真断言」制造虚假通过。
// 覆盖点来自 PRD 需求编号，实现后请把 it.todo 改为 it 并补上真实断言。
//
// 参考已有实现：AI 生成与评审的核心逻辑在 src/services/ai.service.ts，
// 对应的真实单元测试见 tests/ai-service.test.ts（已覆盖缓存绕过、流式生成、
// AGENTS 合并、评审补丁回退等）。本文件待补的是 /api/ai/* 接口层测试。
//
// 注：原文件 mock 了 openai SDK，但源码中的 AI 调用全部走原生 fetch，
// 从未 import 'openai'，该 mock 不生效，已一并移除。

describe('AI Service', () => {
  describe('POST /api/ai/generate', () => {
    // DOC-04: AI content generation
    it.todo('should generate document via MiniMax API');
    // D-01: MiniMax API config
    it.todo('should use correct model and parameters');
    // Security: IDOR prevention
    it.todo('should reject generation for other users projects');
  });

  describe('Domain Templates', () => {
    // D-08: SE template differentiation
    it.todo('should use SE template for software engineering domain');
    // D-09: BD template differentiation
    it.todo('should use BD template for big data domain');
    // D-05: PRD standard structure
    it.todo('should generate PRD with correct structure');
  });

  describe('Error Handling', () => {
    // 30s timeout handling
    it.todo('should handle API timeout gracefully');
    // T-03-01-01: API key protection
    it.todo('should not expose API key in response');
  });
});
