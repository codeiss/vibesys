import { DocType, Domain, Platform, PrismaClient } from '../generated/prisma';
import { apiProviderService } from './apiProvider.service.js';
import { getPRDPromptTemplate } from '../prompts/prd.template.js';
import { getFrontendPromptTemplate } from '../prompts/frontend.template.js';
import { getBackendPromptTemplate } from '../prompts/backend.template.js';
import { getAPIPromptTemplate } from '../prompts/api.template.js';
import { getTaskPromptTemplate } from '../prompts/task.template.js';
import { getContextStatePromptTemplate } from '../prompts/context_state.template.js';
import {
  getReviewSystemPrompt,
  buildReviewUserPrompt,
  getPatchHintRecoverySystemPrompt,
  buildPatchHintRecoveryUserPrompt
} from '../prompts/review.template.js';
import { getAgentsPromptTemplate } from '../prompts/agents.template.js';
import { logger } from '../lib/logger.js';
import { generateMockDocument, generateMockReviewResult } from './ai/mock.js';

/**
 * AI Service for document generation
 * D-01: Uses school's self-deployed MiniMax API via OpenAI SDK
 * D-02: Independent service module for future extensibility
 */

export interface TopicInfo {
  title: string;
  description: string;
  domain: Domain;
  platform: Platform;
  objectives: string | null;
  techStack: string[];
  datasetName?: string;
  datasetCategory?: string;
  previousDocs?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface StreamChunkChoice {
  finish_reason?: string | null;
  delta?: {
    content?: string;
    reasoning_content?: string;
    reasoning_details?: Array<{
      text?: string;
    }>;
  };
}

interface StreamChunkResponse {
  choices?: StreamChunkChoice[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface GenerationProgress {
  phase: 'reasoning' | 'writing' | 'finalizing';
  reasoningText: string;
  contentText: string;
  tokenCount?: number;
  tokensPerSecond?: number;
  elapsedSeconds?: number;
}

interface GenerationOptions {
  bypassCache?: boolean;
  signal?: AbortSignal;
  userId?: number;
  prisma?: any;
  env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string };
}

interface PendingRequest {
  promise: Promise<string>;
  timestamp: number;
}

interface ExecuteResult {
  content: string;
  usage: TokenUsage;
}

export interface ReviewIssue {
  id: number;
  severity: 'critical' | 'warning' | 'suggestion';
  category: 'prd_vs_frontend' | 'prd_vs_backend' | 'backend_vs_api' | 'frontend_vs_api' | 'overall';
  title: string;
  description: string;
  affectedDocTypes: DocType[];
  suggestion: string;
  patchHints: ReviewPatchHint[];
}

export interface ReviewResult {
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewPatchHint {
  docType: DocType;
  changeType: 'replace_section' | 'replace_range';
  targetHeadingPath: string[];
  anchorBefore?: string;
  anchorAfter?: string;
  replacementContent: string;
}

export interface ReviewUnresolvedFix {
  docType: DocType;
  issueId: number;
  reason: string;
  fallbackNote: string;
  targetHeadingPath?: string[];
  anchorBefore?: string;
  anchorAfter?: string;
}

export interface ReviewFixResult {
  documents: Map<string, string>;
  unresolved: ReviewUnresolvedFix[];
}

interface CachedResult {
  content: string;
  timestamp: number;
}

interface SectionRange {
  startIndex: number;
  endIndex: number;
  headingLine: string;
}

export class AIService {
  private _prisma?: PrismaClient;
  private _env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string };

  setContext(prisma: PrismaClient, env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string }) {
    this._prisma = prisma;
    this._env = env;
  }

  private readonly AGENTS_AUDIT_REWRITE_PRIORITY_SECTION = `## 最高优先规则

1. 在开始任何编码、拆任务、写实现或调用外部 AI 工具之前，必须先审核全部 7 份项目文档：PRD.md、Frontend.md、Backend.md、API.md、task.md、context_state.md、AGENTS.md。
2. 只要任意文档中存在“审核修订记录”或“审核修订”内容，必须先依据这些修订记录重新编排、整合并规划相关文档内容，确保文档结构、术语、接口、任务顺序和执行约束已经吸收修订结果。
3. 完成上述整理前，不得直接进入编码阶段，也不得忽略修订记录继续实现。
4. 当用户在 AI 编程工具中输入“了解项目规则，查看 AGENTS.md 文档”时，必须立即先执行本规则，再开始后续编码引导。`;

  private readonly AGENTS_CLAUDE_GUIDELINES_SECTION = `## CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.
- Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" -> "Write tests for invalid inputs, then make them pass"
- "Fix the bug" -> "Write a test that reproduces it, then make it pass"
- "Refactor X" -> "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] -> verify: [check]
2. [Step] -> verify: [check]
3. [Step] -> verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.`;

  // Request deduplication map: cacheKey -> pending promise
  private pendingRequests = new Map<string, PendingRequest>();

  // Result cache: cacheKey -> { content, timestamp }
  private resultCache = new Map<string, CachedResult>();

  private readonly CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly REQUEST_TIMEOUT = 600_000; // 600 seconds (10 min) timeout
  private readonly REVIEW_TIMEOUT = 360_000; // 360 seconds (6 minutes) timeout for expert panel review

  /**
   * Generate cache key from docType and topic info
   */
  private async generateCacheKey(docType: DocType, topicInfo: TopicInfo): Promise<string> {
    const payload = {
      docType,
      title: topicInfo.title,
      description: topicInfo.description,
      domain: topicInfo.domain,
      platform: topicInfo.platform,
      objectives: topicInfo.objectives,
      techStack: [...topicInfo.techStack].sort(),
      previousDocs: Object.entries(topicInfo.previousDocs || {})
        .sort(([left], [right]) => left.localeCompare(right))
    };

    const data = new TextEncoder().encode(JSON.stringify(payload));
    // 用 SHA-256 而非 MD5：Workers 运行时把 MD5 作为非标准扩展支持，
    // 但 Node 的 WebCrypto 不支持（会抛 "Unrecognized algorithm name"），
    // 本地开发与测试都会崩。缓存键仅存于内存 Map、不做持久化，
    // 换算法不影响任何已有数据。
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async getConfig(userId?: number, prisma?: PrismaClient, env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string }) {
    const p = prisma || this._prisma;
    const e = env || this._env;
    const providerConfig = userId && p
      ? await apiProviderService.getConfigForUser(p, userId, e)
      : p
        ? await apiProviderService.getEffectiveConfig(p, e)
        : userId
          ? await apiProviderService.getConfigForUser(userId)
          : await apiProviderService.getEffectiveConfig();
    const mockMode = process.env.MOCK_AI === 'true' || process.env.MOCK_AI === '1';

    if (!providerConfig.apiKey && !mockMode) {
      throw new Error('No active API provider configured — set up one in admin panel or configure MINIMAX_API_KEY in .env');
    }

    return {
      baseURL: providerConfig.baseURL,
      apiKey: providerConfig.apiKey,
      model: providerConfig.model,
      mockMode,
      providerConfig,
    };
  }

  /**
   * Estimate token count from text content.
   * Fallback when API does not return usage info.
   * Chinese characters ≈ 1 token, English words ≈ 1.3 tokens.
   */
  estimateTokens(text: string): TokenUsage {
    const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    const otherChars = text.length - chineseChars - englishWords;
    const completionTokens = Math.ceil(chineseChars + englishWords * 1.3 + otherChars * 0.5);
    // Prompt tokens are harder to estimate without the original prompt;
    // use a rough ratio for estimation
    const promptTokens = Math.ceil(completionTokens * 0.3);
    return {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens
    };
  }

  /**
   * Generate document content via MiniMax API
   * DOC-04: AI content generation
   * D-08/09: Domain-specific templates
   */
  async generateDocument(
    docType: DocType,
    topicInfo: TopicInfo,
    options: GenerationOptions = {}
  ): Promise<{ content: string; usage: TokenUsage }> {
    const config = await this.getConfig(options.userId, options.prisma, options.env);

    // Mock mode for development/testing when API is unavailable
    if (config.mockMode) {
      logger.debug('[AI Mock] Generating mock document for', docType);
      const content = this.postProcessGeneratedContent(docType, generateMockDocument(docType, topicInfo));
      const usage = this.estimateTokens(content);
      return { content, usage };
    }

    const cacheKey = await this.generateCacheKey(docType, topicInfo);
    const bypassCache = options.bypassCache === true;

    if (!bypassCache) {
      // 1. Check result cache
      const cached = this.resultCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        logger.debug('[AI Cache] Hit for', cacheKey);
        const content = this.postProcessGeneratedContent(docType, cached.content);
        const usage = this.estimateTokens(content);
        return { content, usage };
      }

      // 2. Check pending request (deduplication)
      const pending = this.pendingRequests.get(cacheKey);
      if (pending && Date.now() - pending.timestamp < 60_000) {
        logger.debug('[AI Dedup] Reusing pending request for', cacheKey);
        const content = await pending.promise;
        const usage = this.estimateTokens(content);
        return { content, usage };
      }
    }

    // 3. Execute new request
    const systemPrompt = this.getSystemPrompt(docType, topicInfo.domain);
    const userPrompt = this.buildUserPrompt(docType, topicInfo);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const requestPromise = this.executeWithRetry(messages, options.userId)
      .then(result => this.postProcessGeneratedContent(docType, result.content));

    // Record pending request
    this.pendingRequests.set(cacheKey, {
      promise: requestPromise,
      timestamp: Date.now()
    });

    try {
      const content = await requestPromise;

      // Cache result
      this.resultCache.set(cacheKey, {
        content,
        timestamp: Date.now()
      });

      const usage = this.estimateTokens(content);
      return { content, usage };
    } finally {
      // Clean up pending marker
      this.pendingRequests.delete(cacheKey);
    }
  }

  async generateDocumentStream(
    docType: DocType,
    topicInfo: TopicInfo,
    onProgress: (progress: GenerationProgress) => void,
    options: GenerationOptions = {}
  ): Promise<{ content: string; usage: TokenUsage }> {
    const config = await this.getConfig(options.userId, options.prisma, options.env);

    if (config.mockMode) {
      const content = await this.streamMockDocument(docType, topicInfo, onProgress);
      const finalized = this.postProcessGeneratedContent(docType, content);
      if (finalized !== content) {
        onProgress({
          phase: 'finalizing',
          reasoningText: this.buildPreviewReasoningText('finalizing'),
          contentText: finalized
        });
      }
      const usage = this.estimateTokens(finalized);
      return { content: finalized, usage };
    }

    const cacheKey = await this.generateCacheKey(docType, topicInfo);
    const bypassCache = options.bypassCache === true;

    if (!bypassCache) {
      const cached = this.resultCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        const finalizedCached = this.postProcessGeneratedContent(docType, cached.content);
        onProgress({
          phase: 'finalizing',
          reasoningText: this.buildPreviewReasoningText('finalizing'),
          contentText: finalizedCached
        });
        const usage = this.estimateTokens(finalizedCached);
        return { content: finalizedCached, usage };
      }
    }

    const systemPrompt = this.getSystemPrompt(docType, topicInfo.domain);
    const userPrompt = this.buildUserPrompt(docType, topicInfo);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    const result = await this.executeStreamWithRetry(messages, onProgress, options.signal, false, options.userId);
    const finalized = this.postProcessGeneratedContent(docType, result.content);

    if (finalized !== result.content) {
      onProgress({
        phase: 'finalizing',
        reasoningText: this.buildPreviewReasoningText('finalizing'),
        contentText: finalized
      });
    }

    this.resultCache.set(cacheKey, {
      content: finalized,
      timestamp: Date.now()
    });

    return { content: finalized, usage: result.usage };
  }

  /**
   * Execute AI request with retry logic
   */
  private async executeWithRetry(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    userId?: number
  ): Promise<ExecuteResult> {
    const { baseURL, apiKey, model } = await this.getConfig(userId);
    const contentParts: string[] = [];
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    const maxAttempts = 3;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const data = await this.requestCompletion(baseURL, apiKey, model, messages);
        const choice = data.choices?.[0];
        const content = choice?.message?.content?.trim() || '';

        if (!content) {
          break;
        }

        contentParts.push(content);

        if (data.usage) {
          totalUsage.promptTokens += data.usage.prompt_tokens || 0;
          totalUsage.completionTokens += data.usage.completion_tokens || 0;
          totalUsage.totalTokens += data.usage.total_tokens || 0;
        }

        if (choice?.finish_reason !== 'length') {
          break;
        }

        logger.debug(`[AI] Continuation triggered (attempt ${attempt + 1}, finish_reason=length, chars=${content.length})`);

        messages = [
          { role: 'system', content: this.buildContinuationSystemPrompt() },
          { role: 'user', content: this.buildContinuationUserPrompt(content) }
        ];
      } catch (error) {
        if (attempt === maxAttempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    const finalContent = this.cleanGeneratedContent(this.mergeContinuationParts(contentParts));
    if (totalUsage.totalTokens === 0) {
      totalUsage = this.estimateTokens(finalContent);
    }
    return { content: finalContent, usage: totalUsage };
  }

  private async executeStreamWithRetry(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onProgress: (progress: GenerationProgress) => void,
    signal?: AbortSignal,
    isContinuation = false,
    userId?: number
  ): Promise<ExecuteResult> {
    const { baseURL, apiKey, model } = await this.getConfig(userId);
    const maxAttempts = 3;
    const contentParts: string[] = [];
    let totalUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await this.requestStreamingCompletion(
          baseURL, apiKey, model, messages, onProgress, signal, attempt > 0
        );

        const cleanedContent = result.contentText.trim();
        if (!cleanedContent) {
          break;
        }

        contentParts.push(cleanedContent);

        if (result.usage) {
          totalUsage.promptTokens += result.usage.promptTokens || 0;
          totalUsage.completionTokens += result.usage.completionTokens || 0;
          totalUsage.totalTokens += result.usage.totalTokens || 0;
        }

        if (result.finishReason !== 'length') {
          break;
        }

        logger.debug(`[AI Stream] Continuation triggered (attempt ${attempt + 1}, finished reason=length, chars=${cleanedContent.length})`);

        messages = [
          { role: 'system', content: this.buildContinuationSystemPrompt() },
          { role: 'user', content: this.buildContinuationUserPrompt(cleanedContent) }
        ];
      } catch (error) {
        if (attempt === maxAttempts - 1) throw error;
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }

    const finalContent = this.cleanGeneratedContent(this.mergeContinuationParts(contentParts));
    if (contentParts.length > 1) {
      logger.debug(`[AI Stream] Merged ${contentParts.length} parts, final=${finalContent.length} chars`);
    }
    if (totalUsage.totalTokens === 0) {
      totalUsage = this.estimateTokens(finalContent);
    }
    onProgress({
      phase: 'finalizing',
      reasoningText: this.buildPreviewReasoningText('finalizing'),
      contentText: finalContent,
      tokenCount: contentParts.reduce((acc, part) => acc + part.split(/\s+/).length, 0),
      elapsedSeconds: 0,
    });
    return { content: finalContent, usage: totalUsage };
  }

  /**
   * Get system prompt based on docType and domain
   * D-08/09: Domain differentiation
   */
  private getSystemPrompt(docType: DocType, domain: Domain): string {
    switch (docType) {
      case 'PRD':
        return this.getPRDSystemPrompt(domain);
      case 'FRONTEND':
        return this.getFrontendSystemPrompt(domain);
      case 'BACKEND':
        return this.getBackendSystemPrompt(domain);
      case 'API':
        return this.getAPISystemPrompt(domain);
      case 'TASK':
        return this.getTaskSystemPrompt(domain);
      case 'CONTEXT_STATE':
        return this.getContextStateSystemPrompt(domain);
      case 'AGENTS':
        return this.getAgentsSystemPrompt(domain);
      default:
        return '请生成结构化的技术文档。';
    }
  }

  /**
   * Build user prompt with topic info and previous document context
   */
  private buildUserPrompt(docType: DocType, topicInfo: TopicInfo): string {
    const platformLabels: Record<string, string> = {
      WEB: 'Web应用（浏览器访问）',
      IOS: 'iOS原生应用',
      ANDROID: 'Android原生应用',
      WECHAT_MINI: '微信小程序',
      WINDOWS_DESKTOP: 'Windows桌面端',
      MAC_DESKTOP: 'Mac桌面端'
    };
    const platformLabel = platformLabels[topicInfo.platform] ?? topicInfo.platform;

    const datasetSection = (topicInfo.domain === 'BD' && topicInfo.datasetName)
      ? `**数据集名称**: ${topicInfo.datasetName}\n**数据方向分类**: ${topicInfo.datasetCategory || ''}\n`
      : '';

    const baseInfo = `
**选题标题**: ${topicInfo.title}
**选题描述**: ${topicInfo.description}
**领域**: ${topicInfo.domain === 'SE' ? '软件工程' : '大数据'}
**运行平台**: ${platformLabel}
**项目目标**: ${topicInfo.objectives}
**推荐技术栈**: ${topicInfo.techStack.join(', ')}
${datasetSection}`;

    let contextSection = '';
    if (topicInfo.previousDocs && Object.keys(topicInfo.previousDocs).length > 0) {
      contextSection = '\n### 参考文档（前置文档内容）\n\n';
      for (const [dType, content] of Object.entries(topicInfo.previousDocs)) {
        const truncated = content.length > 6000
          ? content.substring(0, 6000) + '\n...(内容过长已截断)'
          : content;
        contextSection += `#### ${dType} 文档\n\n${truncated}\n\n`;
      }
    }

    const docTypeLabels: Record<DocType, string> = {
      PRD: '产品需求文档',
      FRONTEND: '前端技术文档',
      BACKEND: '后端技术文档',
      API: 'API 接口契约文档',
      TASK: '开发任务清单',
      CONTEXT_STATE: '项目状态追踪文档',
      AGENTS: 'AI 编码规则文档'
    };

    const bdConstraint = (topicInfo.domain === 'BD' && topicInfo.datasetName)
      ? `\n注意：文档内容必须紧扣上述数据集，不得编造数据集的字段、规模、来源或特征；所有功能模块、数据处理流程、模型选型均应围绕该数据集的实际特点展开。`
      : '';

    return `
请根据以下选题信息生成${docTypeLabels[docType]}，直接输出最终 Markdown 文档，不要输出分析过程、思考说明、前言或多余内容。
${baseInfo}${contextSection}${bdConstraint}
文档必须一次性尽可能完整输出；如果内容较长，也必须优先保证结构完整、章节完整、结尾完整。
`;
  }

  private async requestCompletion(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
  ): Promise<ChatCompletionResponse> {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 65536,
      }),
      signal: AbortSignal.timeout(this.REQUEST_TIMEOUT), // 120 seconds timeout
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MiniMax API request failed: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  }

  private async requestStreamingCompletion(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onProgress: (progress: GenerationProgress) => void,
    signal?: AbortSignal,
    isContinuation = false
  ): Promise<{ reasoningText: string; contentText: string; finishReason: string | null; tokenCount: number; usage: TokenUsage }> {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 65536,
        stream: true,
        reasoning_split: true
      }),
      signal: this.createRequestSignal(this.REQUEST_TIMEOUT, signal),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MiniMax API request failed: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('MiniMax API stream is unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let reasoningText = '';
    let contentText = '';
    let finishReason: string | null = null;
    let lastEmitAt = 0;
    let tokenCount = 0;
    const startTime = Date.now();

    const extractNextEventBlock = (): string | null => {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        return null;
      }

      const block = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + match[0].length);
      return block;
    };

    const emitProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastEmitAt < 120) {
        return;
      }

      let previewContentText = this.extractPreviewContent(contentText);

      // During continuation, suppress progress events that contain a document
      // restart (H1 title). The model may ignore the continuation instruction
      // and regenerate from scratch; showing this to the frontend creates a
      // confusing visual "jump back to the beginning" in the terminal overlay.
      if (isContinuation && previewContentText) {
        const hasH1 = /^#\s+/m.test(previewContentText);
        if (hasH1) {
          logger.debug('[AI Stream] Continuation produced H1 restart, suppressing from UI preview');
          previewContentText = '';
        }
      }

      const phase: GenerationProgress['phase'] = previewContentText
        ? 'writing'
        : reasoningText || contentText
          ? 'reasoning'
          : 'reasoning';

      const elapsedSeconds = Math.floor((now - startTime) / 1000);
      const tokensPerSecond = elapsedSeconds > 0 ? tokenCount / elapsedSeconds : 0;

      onProgress({
        phase,
        reasoningText: this.buildPreviewReasoningText(phase),
        contentText: previewContentText,
        tokenCount,
        tokensPerSecond,
        elapsedSeconds,
      });
      lastEmitAt = now;
    };

    const processEventBlock = (block: string): void => {
      const dataLines = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());

      if (dataLines.length === 0) {
        return;
      }

      const payload = dataLines.join('\n');
      if (payload === '[DONE]') {
        return;
      }

      const chunk = JSON.parse(payload) as StreamChunkResponse;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (!delta) {
        return;
      }

      const reasoningIncoming = this.extractReasoningText(delta);
      const reasoningDelta = this.getNovelSuffix(reasoningText, reasoningIncoming);
      if (reasoningDelta) {
        reasoningText += reasoningDelta;
      }

      const contentIncoming = delta.content || '';
      const contentDelta = this.getNovelSuffix(contentText, contentIncoming);
      if (contentDelta) {
        contentText += contentDelta;
        tokenCount += 1;
      }

      if (choice?.finish_reason) {
        finishReason = choice.finish_reason;
      }

      if (reasoningDelta || contentDelta) {
        emitProgress();
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let block = extractNextEventBlock();

      while (block !== null) {
        if (block) {
          processEventBlock(block);
        }

        block = extractNextEventBlock();
      }
    }

    if (buffer.trim()) {
      processEventBlock(buffer.trim());
    }

    emitProgress(true);

    // Build usage from accumulated token count and estimate prompt tokens
    const usage: TokenUsage = {
      promptTokens: Math.ceil(tokenCount * 0.3),
      completionTokens: tokenCount,
      totalTokens: Math.ceil(tokenCount * 1.3)
    };

    return {
      reasoningText,
      contentText,
      finishReason,
      tokenCount,
      usage,
    };
  }

  private extractReasoningText(delta: StreamChunkChoice['delta']): string {
    const reasoningDetails = delta?.reasoning_details
      ?.map(detail => detail.text || '')
      .join('') || '';

    return delta?.reasoning_content || reasoningDetails;
  }

  /**
   * Continuation system prompt - replaces the original system prompt.
   * The original says "从文档标题开始", which conflicts with continuation.
   */
  private buildContinuationSystemPrompt(): string {
    return [
      '你是一位专业的技术文档续写助手。',
      '你正在续写一份已被截断、尚未完成的 Markdown 文档。',
      '',
      '核心规则：',
      '- 你收到的上文是截断前的最后一段，请紧接其后继续输出',
      '- 严禁输出文档标题（# 开头）',
      '- 严禁重复任何已输出过的章节或内容',
      '- 如果上一段句子不完整，先补全该句子',
      '- 直接输出剩余 Markdown 正文，不解释、不道歉'
    ].join('\n');
  }

  private buildContinuationUserPrompt(previousTail: string): string {
    // Grab the last ~800 meaningful characters as continuation anchor
    const tailText = previousTail.slice(-800).trim();
    const truncationNote = tailText.length < previousTail.trim().length
      ? '（以上为上一轮输出的最后部分，完整内容已省略）\n\n'
      : '';

    return [
      truncationNote + '上一条回答因长度限制被截断。以下是截断前的最后一段：',
      '',
      '```',
      tailText,
      '```',
      '',
      '请严格从上述内容之后继续生成剩余部分：',
      '- 严禁输出文档标题（# 开头的内容）',
      '- 严禁重复已输出过的任何章节、段落、表格、代码块或列表',
      '- 如果上一个句子或表格不完整，先补全再继续新内容',
      '- 直接输出 Markdown 正文，不要解释、道歉或说明"继续"'
    ].join('\n');
  }

  private getNovelSuffix(existing: string, incoming: string): string {
    if (!incoming) {
      return '';
    }

    if (!existing) {
      return incoming;
    }

    if (incoming.startsWith(existing)) {
      return incoming.slice(existing.length);
    }

    if (existing.endsWith(incoming)) {
      return '';
    }

    const maxOverlap = Math.min(existing.length, incoming.length, 4000);
    for (let length = maxOverlap; length > 4; length -= 1) {
      if (existing.endsWith(incoming.slice(0, length))) {
        return incoming.slice(length);
      }
    }

    return incoming;
  }

  private cleanGeneratedContent(content: string): string {
    const trimmed = content.trim();
    const firstHeadingIndex = trimmed.search(/^#\s+/m);

    if (firstHeadingIndex > 0) {
      return trimmed.slice(firstHeadingIndex).trim();
    }

    return trimmed;
  }

  private postProcessGeneratedContent(docType: DocType, content: string): string {
    let cleaned = this.cleanGeneratedContent(content);

    if (this.isMarkdownGeneratedDoc(docType)) {
      cleaned = this.removeRepeatedMarkdownRestarts(cleaned);
    }

    if (docType !== 'AGENTS') {
      return cleaned;
    }

    return this.mergeAgentsRequiredSections(cleaned);
  }

  private isMarkdownGeneratedDoc(docType: DocType): boolean {
    return ['PRD', 'FRONTEND', 'BACKEND', 'API', 'TASK', 'CONTEXT_STATE', 'AGENTS'].includes(docType);
  }

  private mergeContinuationParts(parts: string[]): string {
    if (parts.length === 0) {
      return '';
    }

    let merged = parts[0].trim();

    for (const part of parts.slice(1)) {
      const next = part.trim();
      if (!next) {
        continue;
      }

      let novel: string;

      // If `next` is a continuation (no H1 title), just append it.
      // If `next` has an H1 that matches the existing document's H1,
      // treat it as a restart and extract only novel sections.
      const nextHasH1 = /^#\s+/m.test(next);
      if (!nextHasH1) {
        novel = this.removeOverlappingPrefix(merged, next);
      } else {
        const withoutRestart = this.removeRepeatedDocumentRestart(merged, next);
        novel = this.removeOverlappingPrefix(merged, withoutRestart);
      }

      if (novel) {
        merged = `${merged}\n\n${novel}`.trim();
      }
    }

    return merged;
  }

  private removeRepeatedDocumentRestart(existing: string, incoming: string): string {
    const existingTitle = existing.match(/^#\s+(.+)$/m)?.[1]?.trim();
    const incomingTitleMatch = incoming.match(/^#\s+(.+)$/m);

    if (!existingTitle || !incomingTitleMatch || incomingTitleMatch.index === undefined) {
      return incoming;
    }

    const incomingTitle = incomingTitleMatch[1].trim();

    // Fuzzy title comparison to handle minor rephrasing by the model
    const normExisting = existingTitle.replace(/\s+/g, ' ').toLowerCase();
    const normIncoming = incomingTitle.replace(/\s+/g, ' ').toLowerCase();
    if (normIncoming !== normExisting) {
      return incoming;
    }

    const afterRepeatedTitle = incoming.slice(incomingTitleMatch.index + incomingTitleMatch[0].length).trim();
    return this.sliceFromFirstNovelSecondLevelSection(existing, afterRepeatedTitle);
  }

  private removeRepeatedMarkdownRestart(content: string): string {
    const titleMatches = [...content.matchAll(/^#\s+(.+)$/gm)];
    if (titleMatches.length <= 1) {
      return content;
    }

    let cleaned = content.slice(0, titleMatches[1].index).trim();
    const originalPrefix = cleaned;

    for (const titleMatch of titleMatches.slice(1)) {
      if (titleMatch.index === undefined) {
        continue;
      }

      const nextTitleIndex = titleMatches.find(match => (match.index ?? -1) > titleMatch.index!)?.index;
      const restartBlock = content
        .slice(titleMatch.index + titleMatch[0].length, nextTitleIndex)
        .trim();
      const novel = this.sliceFromFirstNovelSecondLevelSection(originalPrefix, restartBlock);
      if (novel) {
        cleaned = `${cleaned}\n\n${novel}`.trim();
      }
    }

    return cleaned;
  }

  private removeRepeatedMarkdownRestarts(content: string): string {
    let cleaned = this.removeRepeatedMarkdownRestart(content);
    cleaned = this.removeRepeatedSecondLevelSectionRestart(cleaned);
    return cleaned;
  }

  private removeRepeatedSecondLevelSectionRestart(content: string): string {
    const sectionMatches = [...content.matchAll(/^##\s+(.+)$/gm)];
    if (sectionMatches.length <= 1) {
      return content;
    }

    const seenHeadings = new Set<string>();
    for (const section of sectionMatches) {
      if (section.index === undefined) {
        continue;
      }

      const heading = section[1].trim();
      if (!seenHeadings.has(heading)) {
        seenHeadings.add(heading);
        continue;
      }

      const prefix = content.slice(0, section.index).trim();
      const restartBlock = content.slice(section.index).trim();
      const novel = this.sliceFromFirstNovelSecondLevelSection(prefix, restartBlock);
      return novel ? `${prefix}\n\n${novel}`.trim() : prefix;
    }

    return content;
  }

  private sliceFromFirstNovelSecondLevelSection(existing: string, incoming: string): string {
    const sectionMatches = [...incoming.matchAll(/^##\s+(.+)$/gm)];
    if (sectionMatches.length === 0) {
      return this.removeOverlappingPrefix(existing, incoming);
    }

    for (const section of sectionMatches) {
      if (section.index === undefined) {
        continue;
      }

      const heading = section[1].trim();
      const headingPattern = new RegExp(`^##\\s+${this.escapeRegExp(heading)}\\s*$`, 'm');
      if (!headingPattern.test(existing)) {
        return incoming.slice(section.index).trim();
      }
    }

    return '';
  }

  private removeOverlappingPrefix(existing: string, incoming: string): string {
    if (!incoming) {
      return '';
    }

    if (existing.endsWith(incoming)) {
      return '';
    }

    const maxOverlap = Math.min(existing.length, incoming.length, 4000);
    for (let length = maxOverlap; length > 4; length -= 1) {
      if (existing.endsWith(incoming.slice(0, length))) {
        return incoming.slice(length).trim();
      }
    }

    return incoming;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private mergeAgentsRequiredSections(content: string): string {
    if (!content) {
      return content;
    }

    let nextContent = this.mergeAgentsPriorityRule(content);
    nextContent = this.mergeAgentsClaudeGuidelines(nextContent);
    return nextContent;
  }

  private mergeAgentsPriorityRule(content: string): string {
    if (/^##\s+最高优先规则\b/m.test(content) || /审核修订记录/.test(content) && /了解项目规则，查看 AGENTS\.md 文档/.test(content)) {
      return content;
    }

    const firstHeadingMatch = content.match(/^#\s+.*$/m);
    if (!firstHeadingMatch || firstHeadingMatch.index === undefined) {
      return `${this.AGENTS_AUDIT_REWRITE_PRIORITY_SECTION}\n\n${content}`.trim();
    }

    const headingEnd = firstHeadingMatch.index + firstHeadingMatch[0].length;
    const before = content.slice(0, headingEnd).trimEnd();
    const after = content.slice(headingEnd).trimStart();
    return `${before}\n\n${this.AGENTS_AUDIT_REWRITE_PRIORITY_SECTION}\n\n${after}`.trim();
  }

  private mergeAgentsClaudeGuidelines(content: string): string {
    const priorityRuleIndex = content.indexOf(this.AGENTS_AUDIT_REWRITE_PRIORITY_SECTION);

    if (/^##\s+CLAUDE\.md\b/m.test(content) || /Behavioral guidelines to reduce common LLM coding mistakes\./.test(content)) {
      return content;
    }

    const anchors = [
      /^##\s+ContextState 更新规则\b/m,
      /^##\s+文档引用\b/m,
      /^##\s+执行流程\b/m
    ];

    for (const anchor of anchors) {
      const match = anchor.exec(content);
      if (!match || match.index === undefined) {
        continue;
      }

      const before = content.slice(0, match.index).trimEnd();
      const after = content.slice(match.index).trimStart();
      return `${before}\n\n${this.AGENTS_CLAUDE_GUIDELINES_SECTION}\n\n${after}`.trim();
    }

    if (priorityRuleIndex >= 0) {
      const afterPriority = content.slice(priorityRuleIndex + this.AGENTS_AUDIT_REWRITE_PRIORITY_SECTION.length).trimStart();
      const beforePriority = content.slice(0, priorityRuleIndex + this.AGENTS_AUDIT_REWRITE_PRIORITY_SECTION.length).trimEnd();
      return `${beforePriority}\n\n${this.AGENTS_CLAUDE_GUIDELINES_SECTION}\n\n${afterPriority}`.trim();
    }

    return `${content.trimEnd()}\n\n${this.AGENTS_CLAUDE_GUIDELINES_SECTION}\n`.trim();
  }

  private extractPreviewContent(content: string): string {
    const cleaned = this.removeRepeatedMarkdownRestarts(this.cleanGeneratedContent(content));
    const firstHeadingIndex = cleaned.search(/^#\s+/m);

    if (firstHeadingIndex === -1) {
      return '';
    }

    return cleaned.slice(firstHeadingIndex).trim();
  }

  private buildPreviewReasoningText(phase: GenerationProgress['phase']): string {
    if (phase === 'reasoning') {
      return [
        '正在分析前置文档依赖与约束条件。',
        '正在组织章节结构与输出顺序。'
      ].join('\n');
    }

    if (phase === 'writing') {
      return [
        '正在输出正式文档内容。',
        '正在补全当前章节细节并校正文档格式。'
      ].join('\n');
    }

    return [
      '正在整理最终文档结构。',
      '正在执行一致性检查并准备写入项目空间。'
    ].join('\n');
  }

  /**
   * Generate mock document for development/testing
   */

  private async streamMockDocument(
    docType: DocType,
    topicInfo: TopicInfo,
    onProgress: (progress: GenerationProgress) => void
  ): Promise<string> {
    const content = generateMockDocument(docType, topicInfo);
    let streamedContent = '';
    let tokenCount = 0;
    const startTime = Date.now();

    const chunks = content.match(/.{1,80}/gs) || [content];
    for (const chunk of chunks) {
      streamedContent += chunk;
      tokenCount += chunk.split(/\s+/).length;
      const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
      const tokensPerSecond = elapsedSeconds > 0 ? tokenCount / elapsedSeconds : 0;
      onProgress({
        phase: 'writing',
        reasoningText: '',
        contentText: streamedContent,
        tokenCount,
        tokensPerSecond,
        elapsedSeconds,
      });
      await new Promise(resolve => setTimeout(resolve, 90));
    }

    const elapsedSeconds = Math.floor((Date.now() - startTime) / 1000);
    const tokensPerSecond = elapsedSeconds > 0 ? tokenCount / elapsedSeconds : 0;
    onProgress({
      phase: 'finalizing',
      reasoningText: '',
      contentText: streamedContent,
      tokenCount,
      tokensPerSecond,
      elapsedSeconds,
    });

    return this.cleanGeneratedContent(streamedContent);
  }

  /**
   * D-05/D-08: PRD system prompt with SE/BD differentiation
   */
  private getPRDSystemPrompt(domain: Domain): string {
    return `你是一位专业的产品经理，负责产出可直接交付的**精简**中文 Markdown PRD。

${getPRDPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 第一轮必须从文档标题开始，到最后一个章节完整结束
- 如果是在续写上一轮被截断内容，必须从截断位置之后继续，禁止重新输出文档标题或已输出章节
- 全文只允许出现一个一级标题（# ）
- **全文总计不超过 300 行，超过将被视为不合格输出**
- 用列表和表格代替长段落，每个要点一句话即可`;
  }

  /**
   * D-06/D-08: Frontend system prompt with SE/BD differentiation
   */
  private getFrontendSystemPrompt(domain: Domain): string {
    return `你是一位专业的前端架构师，负责产出可直接交付的**精简**中文 Markdown 前端技术文档。

${getFrontendPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 第一轮必须从文档标题开始，并把所有主要章节完整写完
- 如果是在续写上一轮被截断内容，必须从截断位置之后继续，禁止重新输出文档标题或已输出章节
- 全文只允许出现一个一级标题（# ）
- **全文总计不超过 300 行，超过将被视为不合格输出**
- 组件描述用列表，不要为每个组件写大段说明`;
  }

  /**
   * D-07/D-08: Backend system prompt with SE/BD differentiation
   */
  private getBackendSystemPrompt(domain: Domain): string {
    return `你是一位专业的后端架构师，负责产出可直接交付的**精简**中文 Markdown 后端技术文档。

${getBackendPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 第一轮必须从文档标题开始，并把所有主要章节完整写完
- 如果是在续写上一轮被截断内容，必须从截断位置之后继续，禁止重新输出文档标题或已输出章节
- 全文只允许出现一个一级标题（# ）
- **全文总计不超过 300 行，超过将被视为不合格输出**
- 用表格和列表代替长段落`;
  }

  /**
   * API 接口契约文档 system prompt
   */
  private getAPISystemPrompt(domain: Domain): string {
    return `你是一位专业的 API 架构师，负责产出可直接交付的**精简**中文 Markdown API 接口契约文档。

${getAPIPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 接口必须使用 Markdown 表格或代码块描述，但要精简
- 请求/响应示例使用 JSON 格式，每个示例不超过 5 行
- **全文总计不超过 1500 行，严禁超长输出**
- **每个接口描述不超过 10 行，不要为每个接口写一大段说明**
- **如果发现内容即将超长，只列出接口路径和一句话描述，省略示例**`;
  }

  /**
   * 开发任务清单 system prompt
   */
  private getTaskSystemPrompt(domain: Domain): string {
    return `你是一位专业的项目经理，负责产出可直接交付的中文 Markdown 开发任务清单。

${getTaskPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 任务编号使用 T-01, T-02 格式
- 每个任务必须包含明确的验收标准
- **全文总计不超过 200 行，8-12 个核心任务即可**`;
  }

  /**
   * 项目状态追踪文档 system prompt
   */
  private getContextStateSystemPrompt(domain: Domain): string {
    return `你是一位专业的项目协调员，负责产出可直接交付的中文 Markdown 项目状态追踪文档。

${getContextStatePromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- 表格格式必须规范
- 这是一个需要持续更新的文档`;
  }

  /**
   * AI 编码规则文档 system prompt
   */
  private getAgentsSystemPrompt(domain: Domain): string {
    return `你是一位专业的 AI 编程导师，负责产出可直接交付的中文 Markdown AGENTS.md 编码规则文档。

${getAgentsPromptTemplate(domain)}

输出约束：
- 只输出最终 Markdown 文档
- 不要输出思考过程、解释、备注、前言或后记
- ContextState 更新规则部分必须清晰明确
- 这是 AI Coding 工具的主要参考文档`;
  }

  /**
   * Review all documents for cross-document alignment (streaming version)
   * Emits initial phases, then streams the actual AI review output into
   * the terminal so the user sees the review reasoning in real time.
   */
  async reviewDocumentsStream(
    topicInfo: TopicInfo,
    allDocs: Record<string, string>,
    onProgress: (phase: string) => void,
    signal?: AbortSignal,
    userId?: number,
    prisma?: any,
    env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string }
  ): Promise<ReviewResult> {
    const config = await this.getConfig(userId, prisma, env);

    if (config.mockMode) {
      onProgress('正在加载并解析 7 份文档内容...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      onProgress('产品经理：检查 PRD 与前端/后端的一致性...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      onProgress('前端架构师：验证前端文档与 API 契约...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      onProgress('后端架构师：检查后端与 API 的对齐...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      onProgress('总协调员：汇总整体评估意见...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      onProgress('正在生成结构化审核结果...\n');
      await this.delay(500);
      signal?.throwIfAborted();
      const result = generateMockReviewResult();
      onProgress(JSON.stringify(result, null, 2));
      onProgress('\n审核完成');
      return result;
    }

    // Emit initial phases
    onProgress('正在加载并解析 7 份文档内容...\n');
    await this.delay(500);
    signal?.throwIfAborted();
    onProgress('产品经理：检查 PRD 与前端/后端的一致性...\n');
    await this.delay(300);
    signal?.throwIfAborted();
    onProgress('前端架构师：验证前端文档与 API 契约...\n');
    await this.delay(300);
    signal?.throwIfAborted();
    onProgress('后端架构师：检查后端与 API 的对齐...\n');
    await this.delay(300);
    signal?.throwIfAborted();
    onProgress('总协调员：汇总整体评估意见...\n');
    await this.delay(300);
    signal?.throwIfAborted();
    onProgress('正在生成结构化审核结果...\n\n');

    const systemPrompt = getReviewSystemPrompt(topicInfo.domain);
    const userPrompt = buildReviewUserPrompt(topicInfo, allDocs);
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ];

    // Stream the AI response, forwarding raw content to onProgress.
    // We inline the streaming logic here because requestStreamingCompletion
    // passes extractPreviewContent(contentText) which strips JSON output.
    const rawContent = await this.requestStreamingCompletionRaw(
      config.baseURL,
      config.apiKey,
      config.model,
      messages,
      onProgress,
      signal
    );

    const parsedResult = this.parseReviewResult(rawContent);
    const finalized = await this.ensureReviewPatchHints(topicInfo, allDocs, parsedResult);

    onProgress('\n\n审核完成');
    return finalized;
  }

  /**
   * Like requestStreamingCompletion but passes raw accumulated content
   * to onProgress instead of the preview-extracted version.
   * Used for review streaming where the output is JSON, not markdown.
   */
  private async requestStreamingCompletionRaw(
    baseURL: string,
    apiKey: string,
    model: string,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    onRawContent: (rawContent: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        max_tokens: 65536,
        stream: true,
        reasoning_split: true
      }),
      signal: this.createRequestSignal(this.REVIEW_TIMEOUT, signal),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MiniMax API request failed: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error('MiniMax API stream is unavailable');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let contentText = '';
    let lastEmitAt = 0;

    const extractNextEventBlock = (): string | null => {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) {
        return null;
      }
      const block = buffer.slice(0, match.index).trim();
      buffer = buffer.slice(match.index + match[0].length);
      return block;
    };

    const emitProgress = (force = false): void => {
      const now = Date.now();
      if (!force && now - lastEmitAt < 120) {
        return;
      }
      onRawContent(contentText);
      lastEmitAt = now;
    };

    const processEventBlock = (block: string): void => {
      const dataLines = block
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trim());

      if (dataLines.length === 0) return;

      const payload = dataLines.join('\n');
      if (payload === '[DONE]') return;

      const chunk = JSON.parse(payload) as StreamChunkResponse;
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (!delta) return;

      const contentIncoming = delta.content || '';
      const contentDelta = this.getNovelSuffix(contentText, contentIncoming);
      if (contentDelta) {
        contentText += contentDelta;
        emitProgress();
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      let block = extractNextEventBlock();
      while (block !== null) {
        if (block) processEventBlock(block);
        block = extractNextEventBlock();
      }
    }

    if (buffer.trim()) processEventBlock(buffer.trim());
    emitProgress(true);

    return contentText;
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private createRequestSignal(timeoutMs: number, externalSignal?: AbortSignal): AbortSignal {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    if (!externalSignal) {
      return timeoutSignal;
    }

    const controller = new AbortController();
    const abortFrom = (signal: AbortSignal): void => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason);
      }
    };

    if (externalSignal.aborted) {
      abortFrom(externalSignal);
    } else {
      externalSignal.addEventListener('abort', () => abortFrom(externalSignal), { once: true });
    }
    timeoutSignal.addEventListener('abort', () => abortFrom(timeoutSignal), { once: true });

    return controller.signal;
  }

  /**
   * Review all documents for cross-document alignment
   */
  async reviewDocuments(
    topicInfo: TopicInfo,
    allDocs: Record<string, string>,
    userId?: number,
    prisma?: any,
    env?: { MINIMAX_BASE_URL?: string; MINIMAX_API_KEY?: string; MINIMAX_MODEL?: string }
  ): Promise<ReviewResult> {
    const config = await this.getConfig(userId, prisma, env);

    if (config.mockMode) {
      return generateMockReviewResult();
    }

    const systemPrompt = getReviewSystemPrompt(topicInfo.domain);
    const userPrompt = buildReviewUserPrompt(topicInfo, allDocs);
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userPrompt }
    ];

    const rawContent = await this.executeWithRetry(messages);
    const parsedResult = this.parseReviewResult(rawContent.content);
    return this.ensureReviewPatchHints(topicInfo, allDocs, parsedResult);
  }

  /**
   * Fix affected documents based on review findings
   */
  async fixDocuments(
    topicInfo: TopicInfo,
    affectedDocs: Record<string, string>,
    findings: ReviewResult
  ): Promise<ReviewFixResult> {
    const relevantDocTypes = new Set(Object.keys(affectedDocs) as DocType[]);
    const scopedFindings: ReviewResult = {
      summary: findings.summary,
      issues: findings.issues.filter(issue =>
        issue.affectedDocTypes.some(docType => relevantDocTypes.has(docType))
        || issue.patchHints.some(hint => relevantDocTypes.has(hint.docType))
      )
    };
    const hydratedFindings = await this.ensureReviewPatchHints(topicInfo, affectedDocs, scopedFindings);
    const results = new Map<string, string>();
    const unresolved: ReviewUnresolvedFix[] = [];

    for (const [docType, fullContent] of Object.entries(affectedDocs)) {
      const docFindings: ReviewResult = {
        issues: hydratedFindings.issues.filter(issue => issue.affectedDocTypes.includes(docType as DocType)),
        summary: hydratedFindings.summary
      };

      if (docFindings.issues.length === 0) {
        results.set(docType, this.postProcessGeneratedContent(docType as DocType, fullContent));
        continue;
      }

      const fixResult = this.applyStructuredReviewFixes(
        docType as DocType,
        fullContent,
        docFindings
      );
      unresolved.push(...fixResult.unresolved);
      results.set(docType, this.postProcessGeneratedContent(docType as DocType, fixResult.content));
    }

    return {
      documents: results,
      unresolved
    };
  }

  private parseReviewResult(rawContent: string): ReviewResult {
    const candidates = this.extractReviewJsonCandidates(rawContent);

    for (const candidate of candidates) {
      try {
        const parsed = JSON.parse(candidate) as unknown;
        if (this.isReviewResultLike(parsed)) {
          return this.normalizeReviewResult(parsed);
        }
      } catch {
        // Continue trying later candidates. Model output often contains
        // a fenced JSON object plus surrounding prose or earlier examples.
      }
    }

    if (candidates.length > 0) {
      logger.warn('[AI Review] Failed to parse structured review JSON', {
        candidateCount: candidates.length,
        tail: rawContent.slice(-1000)
      });
      return { issues: [], summary: '审核结果解析失败，请重试。' };
    }

    return { issues: [], summary: '审核完成，未发现明显问题。' };
  }

  private extractReviewJsonCandidates(rawContent: string): string[] {
    const content = rawContent.trim().replace(/^\uFEFF/, '');
    const candidates: string[] = [];

    const fencedBlockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let fencedMatch: RegExpExecArray | null;
    while ((fencedMatch = fencedBlockRegex.exec(content)) !== null) {
      const fencedContent = fencedMatch[1]?.trim();
      if (fencedContent) {
        candidates.push(fencedContent);
        candidates.push(...this.extractBalancedJsonObjects(fencedContent));
      }
    }

    candidates.push(...this.extractBalancedJsonObjects(content));

    return Array.from(new Set(candidates))
      .filter(candidate => candidate.trim().startsWith('{') && candidate.trim().endsWith('}'))
      .sort((left, right) => this.scoreReviewJsonCandidate(right) - this.scoreReviewJsonCandidate(left));
  }

  private extractBalancedJsonObjects(content: string): string[] {
    const candidates: string[] = [];
    let startIndex = -1;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < content.length; index += 1) {
      const char = content[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
        continue;
      }

      if (char === '{') {
        if (depth === 0) {
          startIndex = index;
        }
        depth += 1;
        continue;
      }

      if (char === '}' && depth > 0) {
        depth -= 1;
        if (depth === 0 && startIndex >= 0) {
          candidates.push(content.slice(startIndex, index + 1).trim());
          startIndex = -1;
        }
      }
    }

    return candidates;
  }

  private scoreReviewJsonCandidate(candidate: string): number {
    let score = candidate.length > 0 ? 1 : 0;
    if (candidate.includes('"issues"')) score += 4;
    if (candidate.includes('"summary"')) score += 3;
    if (candidate.includes('"patchHints"')) score += 2;
    return score;
  }

  private isReviewResultLike(value: unknown): value is Partial<ReviewResult> {
    return Boolean(
      value
      && typeof value === 'object'
      && (
        Array.isArray((value as Partial<ReviewResult>).issues)
        || typeof (value as Partial<ReviewResult>).summary === 'string'
      )
    );
  }

  private normalizeReviewResult(parsed: Partial<ReviewResult>): ReviewResult {
    const allowedSeverities = new Set<ReviewIssue['severity']>(['critical', 'warning', 'suggestion']);
    const allowedCategories = new Set<ReviewIssue['category']>([
      'prd_vs_frontend',
      'prd_vs_backend',
      'backend_vs_api',
      'frontend_vs_api',
      'overall'
    ]);
    const allowedDocTypes = new Set<string>(Object.values(DocType));

    return {
      issues: Array.isArray(parsed.issues) ? parsed.issues.map((issue, i) => {
        const rawIssue = issue as Partial<ReviewIssue>;
        const severity = allowedSeverities.has(rawIssue.severity as ReviewIssue['severity'])
          ? rawIssue.severity as ReviewIssue['severity']
          : 'suggestion';
        const category = allowedCategories.has(rawIssue.category as ReviewIssue['category'])
          ? rawIssue.category as ReviewIssue['category']
          : 'overall';
        const affectedDocTypes = Array.isArray(rawIssue.affectedDocTypes)
          ? rawIssue.affectedDocTypes.filter((docType): docType is DocType =>
            typeof docType === 'string' && allowedDocTypes.has(docType)
          )
          : [];

        return {
          id: typeof rawIssue.id === 'number' ? rawIssue.id : i + 1,
          severity,
          category,
          title: typeof rawIssue.title === 'string' && rawIssue.title.trim() ? rawIssue.title.trim() : '未命名问题',
          description: typeof rawIssue.description === 'string' ? rawIssue.description.trim() : '',
          affectedDocTypes,
          suggestion: typeof rawIssue.suggestion === 'string' ? rawIssue.suggestion.trim() : '',
          patchHints: this.parseReviewPatchHints(rawIssue.patchHints)
        };
      }) : [],
      summary: typeof parsed.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : '审核完成。'
    };
  }


  private parseReviewPatchHints(rawHints: unknown): ReviewPatchHint[] {
    if (!Array.isArray(rawHints)) {
      return [];
    }

    return rawHints
      .map((rawHint): ReviewPatchHint | null => {
        if (!rawHint || typeof rawHint !== 'object') {
          return null;
        }

        const hint = rawHint as Partial<ReviewPatchHint>;
        const changeType = hint.changeType === 'replace_range' ? 'replace_range' : hint.changeType === 'replace_section' ? 'replace_section' : null;
        const docType = typeof hint.docType === 'string' ? hint.docType as DocType : null;
        const replacementContent = typeof hint.replacementContent === 'string' ? hint.replacementContent.trim() : '';

        if (!docType || !changeType || !replacementContent) {
          return null;
        }

        return {
          docType,
          changeType,
          targetHeadingPath: Array.isArray(hint.targetHeadingPath)
            ? hint.targetHeadingPath.filter((part): part is string => typeof part === 'string').map(part => part.trim()).filter(Boolean)
            : [],
          anchorBefore: typeof hint.anchorBefore === 'string' ? hint.anchorBefore.trim() : undefined,
          anchorAfter: typeof hint.anchorAfter === 'string' ? hint.anchorAfter.trim() : undefined,
          replacementContent
        };
      })
      .filter((hint): hint is ReviewPatchHint => hint !== null);
  }

  private applyStructuredReviewFixes(
    docType: DocType,
    originalContent: string,
    findings: ReviewResult
  ): { content: string; unresolved: ReviewUnresolvedFix[] } {
    let nextContent = this.cleanGeneratedContent(originalContent);
    const unresolved: ReviewUnresolvedFix[] = [];

    for (const issue of findings.issues) {
      const patchHints = issue.patchHints.filter(hint => hint.docType === docType);
      if (patchHints.length === 0) {
        if (issue.patchHints.length > 0) {
          continue;
        }

        unresolved.push({
          docType,
          issueId: issue.id,
          reason: 'missing_patch_hints',
          fallbackNote: this.buildReviewIssueNote(issue)
        });
        continue;
      }

      for (const patchHint of patchHints) {
        const result = this.applyStructuredPatchHint(nextContent, patchHint);
        if (result.applied) {
          nextContent = result.content;
          continue;
        }

        unresolved.push({
          docType,
          issueId: issue.id,
          reason: result.reason || 'patch_apply_failed',
          fallbackNote: this.buildReviewIssueNote(issue),
          targetHeadingPath: patchHint.targetHeadingPath.length > 0 ? patchHint.targetHeadingPath : undefined,
          anchorBefore: patchHint.anchorBefore,
          anchorAfter: patchHint.anchorAfter
        });
      }
    }

    return {
      content: nextContent,
      unresolved
    };
  }

  private applyStructuredPatchHint(
    content: string,
    patchHint: ReviewPatchHint
  ): { applied: boolean; content: string; reason?: string } {
    if (patchHint.changeType === 'replace_section') {
      // Strategy 1: Heading path match (exact + fuzzy)
      const section = this.findSectionByHeadingPath(content, patchHint.targetHeadingPath);
      if (section) {
        return {
          applied: true,
          content: this.replaceSectionByRange(content, section, patchHint.replacementContent)
        };
      }

      // Strategy 2: Anchor-based replacement
      if (patchHint.anchorBefore && patchHint.anchorAfter) {
        return this.applyAnchorPatch(content, patchHint);
      }

      // Strategy 3: Partial heading path + text search within section
      const partialResult = this.findByPartialPathAndText(content, patchHint);
      if (partialResult.applied) {
        return partialResult;
      }

      // Strategy 4: Full-text keyword search
      const textResult = this.findByFullTextSearch(content, patchHint);
      if (textResult.applied) {
        return textResult;
      }

      return { applied: false, content, reason: 'target_heading_path_not_found' };
    }

    if (patchHint.changeType === 'replace_range') {
      const anchorResult = this.applyAnchorPatch(content, patchHint);
      if (anchorResult.applied) {
        return anchorResult;
      }

      if (patchHint.targetHeadingPath.length > 0) {
        const section = this.findSectionByHeadingPath(content, patchHint.targetHeadingPath);
        if (section) {
          return {
            applied: true,
            content: this.replaceSectionByRange(content, section, patchHint.replacementContent)
          };
        }
      }

      // Partial heading path + text search fallback
      const partialResult = this.findByPartialPathAndText(content, patchHint);
      if (partialResult.applied) {
        return partialResult;
      }

      return anchorResult.reason
        ? anchorResult
        : { applied: false, content, reason: 'anchors_not_found' };
    }

    return { applied: false, content, reason: 'unsupported_change_type' };
  }

  private buildReviewIssueNote(issue: ReviewIssue): string {
    const severityLabels: Record<ReviewIssue['severity'], string> = {
      critical: '严重',
      warning: '警告',
      suggestion: '建议'
    };

    const categoryLabels: Record<ReviewIssue['category'], string> = {
      prd_vs_frontend: 'PRD vs 前端',
      prd_vs_backend: 'PRD vs 后端',
      backend_vs_api: '后端 vs API',
      frontend_vs_api: '前端 vs API',
      overall: '整体一致性'
    };

    const detail = issue.suggestion || issue.description || issue.title;
    return `- [${severityLabels[issue.severity]}][${categoryLabels[issue.category]}] ${issue.title}：${detail}`;
  }

  private findSectionByHeadingPath(content: string, targetHeadingPath: string[]): SectionRange | null {
    if (!Array.isArray(targetHeadingPath) || targetHeadingPath.length === 0) {
      return null;
    }

    const lines = content.split(/\r?\n/);
    const normalizedTargetPath = targetHeadingPath.map(part => this.normalizeHeadingLine(part));
    const stack: Array<{ level: number; heading: string; original: string }> = [];

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(/^(#{1,6})\s+/);
      if (!match) {
        continue;
      }

      const level = match[1].length;
      const originalHeading = line.replace(/^(#{1,6})\s+/, '');
      const normalizedHeading = this.normalizeHeadingLine(line);
      
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      stack.push({ level, heading: normalizedHeading, original: originalHeading });

      const currentPath = stack.map(item => item.heading);
      if (this.pathEndsWith(currentPath, normalizedTargetPath)) {
        let endIndex = lines.length;
        for (let end = index + 1; end < lines.length; end += 1) {
          const nextMatch = lines[end].match(/^(#{1,6})\s+/);
          if (nextMatch && nextMatch[1].length <= level) {
            endIndex = end;
            break;
          }
        }

        return {
          startIndex: index,
          endIndex,
          headingLine: line
        };
      }
    }

    // If exact match not found, try fuzzy matching for better robustness
    return this.fuzzyFindSectionByHeadingPath(content, targetHeadingPath, stack);
  }

  /**
   * Fuzzy matching for heading paths to handle minor text differences
   */
  private fuzzyFindSectionByHeadingPath(
    content: string, 
    targetHeadingPath: string[],
    originalStack: Array<{ level: number; heading: string; original: string }>
  ): SectionRange | null {
    if (!Array.isArray(targetHeadingPath) || targetHeadingPath.length === 0) {
      return null;
    }

    const lines = content.split(/\r?\n/);
    const normalizedTargetPath = targetHeadingPath.map(part => this.normalizeHeadingLine(part));
    const targetLastSegment = normalizedTargetPath[normalizedTargetPath.length - 1];
    const targetLastSegmentSimple = targetLastSegment.replace(/[#\s]/g, '').toLowerCase();
    
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const match = line.match(/^(#{1,6})\s+/);
      if (!match) {
        continue;
      }

      const level = match[1].length;
      // Only consider headings that match the depth we're looking for
      if (level !== targetHeadingPath.length) {
        continue;
      }

      const originalHeading = line.replace(/^(#{1,6})\s+/, '');
      const normalizedHeading = this.normalizeHeadingLine(line);
      const normalizedHeadingSimple = normalizedHeading.replace(/[#\s]/g, '').toLowerCase();
      
      // Check for exact match first (fallback)
      if (normalizedHeading === targetLastSegment) {
        // Now check if the parent path matches
        const tempStack: Array<{ level: number; heading: string }> = [];
        for (let i = 0; i < index; i++) {
          const prevLine = lines[i];
          const prevMatch = prevLine.match(/^(#{1,6})\s+/);
          if (!prevMatch) continue;
          
          const prevLevel = prevMatch[1].length;
          const prevHeading = this.normalizeHeadingLine(prevLine);
          
          while (tempStack.length > 0 && tempStack[tempStack.length - 1].level >= prevLevel) {
            tempStack.pop();
          }
          tempStack.push({ level: prevLevel, heading: prevHeading });
        }
        
        const currentPath = tempStack.map(item => item.heading);
        if (this.pathEndsWith(currentPath, normalizedTargetPath.slice(0, -1))) {
          let endIndex = lines.length;
          for (let end = index + 1; end < lines.length; end += 1) {
            const nextMatch = lines[end].match(/^(#{1,6})\s+/);
            if (nextMatch && nextMatch[1].length <= level) {
              endIndex = end;
              break;
            }
          }

          return {
            startIndex: index,
            endIndex,
            headingLine: line
          };
        }
      }
      
      // Check for fuzzy match (contains or partial match)
      if (normalizedHeadingSimple.includes(targetLastSegmentSimple) || 
          targetLastSegmentSimple.includes(normalizedHeadingSimple)) {
        // Simple containment match - use this as a fallback
        let endIndex = lines.length;
        for (let end = index + 1; end < lines.length; end += 1) {
          const nextMatch = lines[end].match(/^(#{1,6})\s+/);
          if (nextMatch && nextMatch[1].length <= level) {
            endIndex = end;
            break;
          }
        }

        return {
          startIndex: index,
          endIndex,
          headingLine: line
        };
      }
    }

    return null;
  }

  /**
   * Strategy 3: Find by partial heading path, then search for text within that section.
   * Handles cases like "## 下一步行动 > 2. T-02 数据库设计" where the last segment
   * is a list item inside the section, not a heading.
   */
  private findByPartialPathAndText(
    content: string,
    patchHint: ReviewPatchHint
  ): { applied: boolean; content: string; reason?: string } {
    const { targetHeadingPath, replacementContent } = patchHint;
    if (targetHeadingPath.length < 2) {
      return { applied: false, content, reason: 'target_heading_path_not_found' };
    }

    // Try matching the parent path (all segments except the last)
    const parentPath = targetHeadingPath.slice(0, -1);
    const lastSegment = targetHeadingPath[targetHeadingPath.length - 1];

    // Find the parent section
    const parentSection = this.findSectionByHeadingPath(content, parentPath);
    if (!parentSection) {
      return { applied: false, content, reason: 'target_heading_path_not_found' };
    }

    // Extract parent section content and search for the last segment text
    const lines = content.split(/\r?\n/);
    const parentLines = lines.slice(parentSection.startIndex, parentSection.endIndex);
    const parentContent = parentLines.join('\n');

    // Normalize the last segment for search
    const normalizedLast = lastSegment
      .replace(/^\d+[\.\)、]\s*/, '') // Remove leading numbering like "2. " or "2) "
      .trim()
      .toLowerCase();

    if (!normalizedLast) {
      // No meaningful text to search — replace entire parent section
      return {
        applied: true,
        content: this.replaceSectionByRange(content, parentSection, replacementContent)
      };
    }

    // Find the line containing the last segment text
    const matchedLineIndex = parentLines.findIndex(line => {
      const normalizedLine = line.replace(/^\s*[-*]\s*/, '').replace(/^\d+[\.\)、]\s*/, '').trim().toLowerCase();
      return normalizedLine.includes(normalizedLast) || normalizedLast.includes(normalizedLine);
    });

    if (matchedLineIndex === -1) {
      // Text not found within parent section — replace entire parent section as last resort
      return {
        applied: true,
        content: this.replaceSectionByRange(content, parentSection, replacementContent)
      };
    }

    // Found the target text — determine its scope (list item block or single line)
    const absoluteMatchIndex = parentSection.startIndex + matchedLineIndex;
    const matchLevel = this.detectListLevel(parentLines[matchedLineIndex]);
    let endOfBlock = matchedLineIndex + 1;
    while (endOfBlock < parentLines.length) {
      const nextLine = parentLines[endOfBlock];
      if (nextLine.trim() === '') { endOfBlock++; continue; }
      const nextLevel = this.detectListLevel(nextLine);
      if (nextLevel <= matchLevel && nextLine.match(/^\s*[-*\d]/)) break;
      if (nextLine.match(/^#{1,6}\s+/)) break;
      if (nextLevel <= matchLevel) break;
      endOfBlock++;
    }

    const blockSection: SectionRange = {
      startIndex: absoluteMatchIndex,
      endIndex: parentSection.startIndex + endOfBlock,
      headingLine: lines[absoluteMatchIndex]
    };

    return {
      applied: true,
      content: this.replaceSectionByRange(content, blockSection, replacementContent)
    };
  }

  /**
   * Strategy 4: Full-text keyword search across the entire document.
   * Extracts key terms from targetHeadingPath and replacementContent,
   * locates the best matching region, and replaces it.
   */
  private findByFullTextSearch(
    content: string,
    patchHint: ReviewPatchHint
  ): { applied: boolean; content: string; reason?: string } {
    const { targetHeadingPath, replacementContent } = patchHint;

    // Extract searchable keywords from the path segments
    const keywords = targetHeadingPath
      .flatMap(segment => segment.split(/[\s>]+/))
      // 先去掉 markdown 标题标记：'## API设计' 会被按空白切成 ['##', 'API设计']，
      // 而 '##' 长度恰好为 2，会通过下面的长度过滤，导致文档里任意标题行都命中，
      // 补丁被插到无关章节。此处清掉 '#' 前缀。
      .map(kw => kw.replace(/^#+/, ''))
      .map(kw => kw.replace(/^\d+[\.\)、]*/, '').trim().toLowerCase())
      // 只保留含字母或数字的词，顺带过滤 '##'、'---' 这类纯标点 token。
      .filter(kw => kw.length >= 2 && /[\p{L}\p{N}]/u.test(kw));

    if (keywords.length === 0) {
      return { applied: false, content, reason: 'target_heading_path_not_found' };
    }

    const lines = content.split(/\r?\n/);
    let bestLineIndex = -1;
    let bestScore = 0;

    for (let i = 0; i < lines.length; i++) {
      const normalizedLine = lines[i].toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (normalizedLine.includes(kw)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLineIndex = i;
      }
    }

    if (bestLineIndex === -1 || bestScore === 0) {
      return { applied: false, content, reason: 'target_heading_path_not_found' };
    }

    // Determine the scope of the matched region
    const matchLine = lines[bestLineIndex];
    const matchLevel = this.detectListLevel(matchLine);
    let endOfBlock = bestLineIndex + 1;
    while (endOfBlock < lines.length) {
      const nextLine = lines[endOfBlock];
      if (nextLine.trim() === '') { endOfBlock++; continue; }
      const nextLevel = this.detectListLevel(nextLine);
      if (nextLine.match(/^#{1,6}\s+/)) break;
      if (nextLevel <= matchLevel && nextLine.match(/^\s*[-*\d]/)) break;
      if (nextLevel <= matchLevel) break;
      endOfBlock++;
    }

    const section: SectionRange = {
      startIndex: bestLineIndex,
      endIndex: endOfBlock,
      headingLine: matchLine
    };

    return {
      applied: true,
      content: this.replaceSectionByRange(content, section, replacementContent)
    };
  }

  private detectListLevel(line: string): number {
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    // Count indent level (2 or 4 spaces per level)
    return Math.floor(indent / 2);
  }

  private replaceSectionByRange(content: string, section: SectionRange, replacementContent: string): string {
    const lines = content.split(/\r?\n/);
    let replacement = this.cleanGeneratedContent(replacementContent);
    const firstReplacementLine = replacement.split(/\r?\n/)[0] || '';

    if (this.normalizeHeadingLine(firstReplacementLine) !== this.normalizeHeadingLine(section.headingLine)) {
      replacement = `${section.headingLine}\n\n${replacement}`.trim();
    }

    const replacementLines = replacement.split(/\r?\n/);
    const mergedLines = [
      ...lines.slice(0, section.startIndex),
      ...replacementLines,
      ...lines.slice(section.endIndex)
    ];

    return mergedLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  private applyAnchorPatch(
    content: string,
    patchHint: ReviewPatchHint
  ): { applied: boolean; content: string; reason?: string } {
    if (!patchHint.anchorBefore || !patchHint.anchorAfter) {
      return { applied: false, content, reason: 'missing_anchors' };
    }

    const startIndex = content.indexOf(patchHint.anchorBefore);
    if (startIndex === -1) {
      return { applied: false, content, reason: 'anchor_before_not_found' };
    }

    const replaceStart = startIndex + patchHint.anchorBefore.length;
    const endIndex = content.indexOf(patchHint.anchorAfter, replaceStart);
    if (endIndex === -1) {
      return { applied: false, content, reason: 'anchor_after_not_found' };
    }

    if (endIndex < replaceStart) {
      return { applied: false, content, reason: 'invalid_anchor_order' };
    }

    const merged = `${content.slice(0, replaceStart)}${patchHint.replacementContent}${content.slice(endIndex)}`;
    return {
      applied: true,
      content: merged.replace(/\n{3,}/g, '\n\n').trim()
    };
  }

  private pathEndsWith(fullPath: string[], targetPath: string[]): boolean {
    if (fullPath.length < targetPath.length) {
      return false;
    }

    const startIndex = fullPath.length - targetPath.length;
    for (let index = 0; index < targetPath.length; index += 1) {
      if (fullPath[startIndex + index] !== targetPath[index]) {
        return false;
      }
    }

    return true;
  }

  private normalizeHeadingLine(line: string): string {
    return line.trim().replace(/\s+/g, ' ').replace(/[^\w\s一-鿿]/g, '').toLowerCase();
  }

  private async ensureReviewPatchHints(
    topicInfo: TopicInfo,
    allDocs: Record<string, string>,
    reviewResult: ReviewResult
  ): Promise<ReviewResult> {
    const issuesNeedingRecovery = reviewResult.issues
      .map(issue => ({
        issue,
        missingDocTypes: issue.affectedDocTypes.filter(docType =>
          Boolean(allDocs[docType])
          && !issue.patchHints.some(hint => hint.docType === docType)
        )
      }))
      .filter(item => item.missingDocTypes.length > 0);

    if (issuesNeedingRecovery.length === 0) {
      return reviewResult;
    }

    const recoverySystemPrompt = getPatchHintRecoverySystemPrompt(topicInfo.domain);
    const recoveryUserPrompt = buildPatchHintRecoveryUserPrompt(
      topicInfo,
      allDocs,
      issuesNeedingRecovery.map(({ issue }) => ({
        id: issue.id,
        category: issue.category,
        title: issue.title,
        description: issue.description,
        suggestion: issue.suggestion,
        affectedDocTypes: issue.affectedDocTypes,
        existingPatchDocTypes: issue.patchHints.map(hint => hint.docType)
      }))
    );

    try {
      const rawRecovery = await this.executeWithRetry([
        { role: 'system', content: recoverySystemPrompt },
        { role: 'user', content: recoveryUserPrompt }
      ]);
      const recoveredPatchHints = this.parsePatchHintRecoveryResult(rawRecovery.content);

      return {
        ...reviewResult,
        issues: reviewResult.issues.map(issue => {
          const extraHints = recoveredPatchHints.get(issue.id) || [];
          if (extraHints.length === 0) {
            return issue;
          }

          const existingKeys = new Set(
            issue.patchHints.map(hint => this.getPatchHintIdentity(hint))
          );
          const mergedHints = [
            ...issue.patchHints,
            ...extraHints.filter(hint => !existingKeys.has(this.getPatchHintIdentity(hint)))
          ];

          return {
            ...issue,
            patchHints: mergedHints
          };
        })
      };
    } catch (error) {
      logger.warn('Patch hint recovery failed:', error);
      return reviewResult;
    }
  }

  private parsePatchHintRecoveryResult(rawContent: string): Map<number, ReviewPatchHint[]> {
    const patchHintsByIssueId = new Map<number, ReviewPatchHint[]>();
    const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return patchHintsByIssueId;
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as {
        patchHintsByIssueId?: Record<string, unknown>;
      };

      for (const [issueId, rawHints] of Object.entries(parsed.patchHintsByIssueId || {})) {
        const numericIssueId = Number(issueId);
        if (Number.isNaN(numericIssueId)) {
          continue;
        }

        patchHintsByIssueId.set(numericIssueId, this.parseReviewPatchHints(rawHints));
      }
    } catch {
      return patchHintsByIssueId;
    }

    return patchHintsByIssueId;
  }

  private getPatchHintIdentity(patchHint: ReviewPatchHint): string {
    return JSON.stringify({
      docType: patchHint.docType,
      changeType: patchHint.changeType,
      targetHeadingPath: patchHint.targetHeadingPath,
      anchorBefore: patchHint.anchorBefore || '',
      anchorAfter: patchHint.anchorAfter || '',
      replacementContent: patchHint.replacementContent
    });
  }
}

export const aiService = new AIService();
export default AIService;
