import { test, expect } from 'vitest';
import { GraduationService } from '../src/services/graduation.service.js';

/**
 * postProcess 是私有方法，这里通过类型断言直接调用，以覆盖生成后的清洗逻辑。
 *
 * 契约来源：src/prompts/task-book.template.ts 与 proposal.template.ts 均要求
 * 模型「只输出最终 Markdown 文档」，且首行必须是 `# 任务书` / `# 毕业设计开题报告`，
 * 并明确禁止 HTML 标签。因此清洗策略是「从第一个 Markdown 一级标题处截断」，
 * 把模型可能泄漏的思考过程、过渡语丢弃。
 */
function createService(): { postProcess(content: string, docType?: string): string } {
  return new GraduationService() as unknown as {
    postProcess(content: string, docType?: string): string;
  };
}

test('task book post-processing strips leaked reasoning preamble before the first H1', () => {
  const service = createService();

  const leakedContent = `开始输出
让我根据提供的 PRD、前端技术文档和后端技术文档来编写任务书内容。

我需要涵盖：

核心功能和模块
技术选型、开发规范、质量标准
预期成果形式

现在我来编写任务书的具体内容。

# 任务书

## 一、研究的主要内容及基本要求

本课题围绕在线图书管理系统展开。

## 二、主要参考资料`;

  const cleaned = service.postProcess(leakedContent, 'TASK_BOOK');

  expect(cleaned).toMatch(/^# 任务书/);
  expect(cleaned).toMatch(/## 一、研究的主要内容及基本要求/);
  expect(cleaned).not.toMatch(/开始输出|让我根据|我需要涵盖|现在我来/);
});

test('task book post-processing unwraps a fenced code block and drops surrounding prose', () => {
  const service = createService();

  const leakedContent = `好的，以下是任务书内容：

\`\`\`markdown
# 任务书

## 一、研究的主要内容及基本要求

系统应实现用户管理、图书管理、借阅管理、检索查询等功能。
\`\`\`

以上为全部内容。`;

  const cleaned = service.postProcess(leakedContent, 'TASK_BOOK');

  expect(cleaned).toMatch(/^# 任务书/);
  expect(cleaned).toMatch(/用户管理、图书管理、借阅管理/);
  expect(cleaned).not.toMatch(/```/);
  expect(cleaned).not.toMatch(/以下是任务书内容|以上为全部内容/);
});

test('post-processing keeps only the first H1 when the model restarts mid-stream', () => {
  const service = createService();

  const restartedContent = `# 任务书

## 一、研究的主要内容及基本要求

第一段内容。

# 任务书

## 一、研究的主要内容及基本要求

第一段内容。`;

  const cleaned = service.postProcess(restartedContent, 'TASK_BOOK');

  expect(cleaned).toMatch(/^# 任务书/);
  expect((cleaned.match(/^# 任务书/gm) ?? []).length).toBe(1);
  expect(cleaned).toMatch(/第一段内容。/);
});

test('proposal post-processing strips source document echoes before the first H1', () => {
  const service = createService();

  const leakedContent = `选题数据：
中文题目：在线图书管理系统

PRD文档内容：
- 项目背景与目标
- 功能模块

前端技术文档：
前端采用 Vue 3 框架配合 Element Plus 组件库进行开发。

后端技术文档：
后端基于 Node.js 和 Express 框架构建 RESTful API。

现在开始撰写开题报告：

# 毕业设计开题报告

## 一、文献综述

### 1. 研究背景和意义

在线图书管理系统能够提升图书流通效率。`;

  const cleaned = service.postProcess(leakedContent, 'PROPOSAL');

  expect(cleaned).toMatch(/^# 毕业设计开题报告/);
  expect(cleaned).toMatch(/提升图书流通效率/);
  expect(cleaned).not.toMatch(/选题数据|PRD文档内容|前端技术文档|后端技术文档|现在开始撰写开题报告/);
});

test('post-processing leaves already-clean markdown untouched', () => {
  const service = createService();

  const cleanContent = `# 任务书

## 一、研究的主要内容及基本要求

本课题围绕在线图书管理系统展开。`;

  expect(service.postProcess(cleanContent, 'TASK_BOOK')).toBe(cleanContent);
});
