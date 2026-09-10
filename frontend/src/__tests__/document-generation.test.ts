import { describe, it, expect } from 'vitest';
import {
  DOC_GENERATION_ORDER,
  DOC_TYPE_LABELS,
  getPreviousDocType,
  getGenerationBlockedReason,
  canGenerateDocument
} from '@/utils/document-generation';
import type { DocType, Document } from '@/types/document';

function buildDocument(docType: DocType, content: string): Document {
  return {
    id: 1,
    projectId: 1,
    docType,
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

describe('DOC_GENERATION_ORDER', () => {
  it('covers every DocType exactly once', () => {
    const expected: DocType[] = [
      'PRD',
      'FRONTEND',
      'BACKEND',
      'API',
      'TASK',
      'CONTEXT_STATE',
      'AGENTS'
    ];

    expect(DOC_GENERATION_ORDER).toEqual(expected);
    expect(new Set(DOC_GENERATION_ORDER).size).toBe(expected.length);
    // 每个 docType 都要有中文标签，否则页面上会显示为空白
    for (const docType of DOC_GENERATION_ORDER) {
      expect(DOC_TYPE_LABELS[docType]).toBeTruthy();
    }
  });
});

describe('getPreviousDocType', () => {
  it('returns null for the first document in the chain', () => {
    expect(getPreviousDocType('PRD')).toBeNull();
  });

  it('returns the preceding document in generation order', () => {
    expect(getPreviousDocType('FRONTEND')).toBe('PRD');
    expect(getPreviousDocType('BACKEND')).toBe('FRONTEND');
    expect(getPreviousDocType('AGENTS')).toBe('CONTEXT_STATE');
  });
});

describe('getGenerationBlockedReason', () => {
  it('allows the first document with no prerequisites', () => {
    expect(getGenerationBlockedReason('PRD', [])).toBeNull();
  });

  it('blocks when the prerequisite document is missing', () => {
    const reason = getGenerationBlockedReason('FRONTEND', []);

    expect(reason).toContain('PRD');
    expect(reason).toContain('前端');
  });

  it('blocks when the prerequisite document has no content', () => {
    const documents = [buildDocument('PRD', '')];

    expect(getGenerationBlockedReason('FRONTEND', documents)).not.toBeNull();
  });

  it('treats whitespace-only prerequisite content as empty', () => {
    const documents = [buildDocument('PRD', '   \n\t  ')];

    expect(getGenerationBlockedReason('FRONTEND', documents)).not.toBeNull();
  });

  it('allows generation once the prerequisite has content', () => {
    const documents = [buildDocument('PRD', '# PRD\n\n在线图书管理系统。')];

    expect(getGenerationBlockedReason('FRONTEND', documents)).toBeNull();
  });

  it('ignores unrelated documents when looking up the prerequisite', () => {
    const documents = [
      buildDocument('BACKEND', '后端内容'),
      buildDocument('PRD', 'PRD 内容')
    ];

    // 前置文档是 PRD（已就绪），不受同时存在的 BACKEND 影响
    expect(canGenerateDocument('FRONTEND', documents)).toBe(true);
  });

  it('does not let a later document unlock an earlier one', () => {
    const documents = [buildDocument('BACKEND', '后端内容')];

    // 生成 BACKEND 需要 FRONTEND，而 FRONTEND 尚未生成
    expect(canGenerateDocument('BACKEND', documents)).toBe(false);
  });
});

describe('canGenerateDocument', () => {
  it('mirrors getGenerationBlockedReason', () => {
    const cases: Array<{ docType: DocType; documents: Document[] }> = [
      { docType: 'PRD', documents: [] },
      { docType: 'FRONTEND', documents: [] },
      { docType: 'FRONTEND', documents: [buildDocument('PRD', '内容')] }
    ];

    for (const { docType, documents } of cases) {
      expect(canGenerateDocument(docType, documents)).toBe(
        getGenerationBlockedReason(docType, documents) === null
      );
    }
  });
});
