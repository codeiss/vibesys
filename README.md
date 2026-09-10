# VibeCoding 教学实践平台

[![CI](https://github.com/liuxm2011/vibesys/actions/workflows/ci.yml/badge.svg)](https://github.com/liuxm2011/vibesys/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

> 用一个选题走完「需求 → 文档 → AI 编码 → 部署」的完整现代软件工程流程。

面向高校计算机 / 软件工程专业的教学实践平台。学生在平台上选题，由 AI 生成结构化的 PRD 与前后端技术文档，再把这些文档作为提示词交给 Claude Code、Codex 等 AI 编码工具完成开发，最终在平台提交仓库与部署地址完成交付。

平台的关注点不是"让 AI 写代码"，而是训练学生在 AI 辅助编程时代真正稀缺的能力：把模糊想法拆解成结构化文档，再让文档驱动代码。

| | |
|---|---|
| 线上环境 | https://vibesys.7878.cloud |
| 后端 API | https://api.7878.cloud |
| 前端 | Vue 3 + TypeScript + Vite + Element Plus |
| 后端 | Cloudflare Workers + Hono + D1 (SQLite) + Prisma |
| 协议 | [MIT](./LICENSE) |

---

## 核心流程

```mermaid
flowchart LR
    A["选题"] --> B["AI 生成 PRD"]
    B --> C["前端技术文档"]
    C --> D["后端技术文档"]
    D --> E["AI 专家评审"]
    E --> F["AI 编码工具开发"]
    F --> G["部署交付"]
```

学生也可以自拟选题提交教师审核；文档生成后支持 AI 评审 → 修复 / 丢弃的迭代闭环，文档质量达标后再进入编码阶段。

---

## 功能

### 学生端

| 模块 | 说明 |
|---|---|
| 登录 | 学号 + 密码，JWT 存 httpOnly Cookie，刷新页面保持会话 |
| 模式选择 | 课程项目与毕业设计双模式，进入后不可随意切换 |
| 选题池 | 按领域（软件工程 / 大数据）与运行平台（Web / 小程序 / 桌面端 / 移动端）筛选，查看选题详情与技术栈建议；支持自拟选题提交审核，选定后锁定 |
| 文档生成 | 一键生成 PRD、前端技术文档、后端技术文档，SSE 流式输出实时可见 |
| AI 专家评审 | 对已生成文档做 AI 评审，给出问题清单，支持「应用修复 / 丢弃」 |
| 文档编辑与导出 | CodeMirror 在线预览编辑，可导出完整文档包（Markdown / ZIP） |
| 个人 API 配置 | 学生可填入自己的 AI API Key，优先于平台共享额度使用 |
| 项目进度与提交 | 跟踪项目状态，填写仓库地址与部署访问地址 |
| 毕业设计 | 毕设选题、数据集预览（CSV 在线预览 + ZIP 下载）、六阶段毕设文档生成 |

平台生成的技术文档包括：PRD、前端技术文档、后端技术文档、API 接口契约、开发任务清单、项目状态追踪文档、AI 编码规则文档（AGENTS.md）。

毕业设计文档覆盖六个阶段：任务书、开题报告、前期准备、撰写阶段、中期检查、完善阶段。

### 管理端

| 模块 | 说明 |
|---|---|
| 用户管理 | 批量导入学生、重置密码、封禁 / 解封、区分默认密码状态 |
| 选题管理 | 维护课题库、审核自拟选题、控制毕设选题开关 |
| 数据统计 | 总览、用户增长、项目分布、AI 用量趋势 |
| API Provider | 配置多个 AI 服务商与模型，控制启用优先级 |
| 仓库管理 | 查看学生项目仓库、按专业 / 班级筛选、按学生去重、标记优秀项目 |
| 归档管理 | 按年级归档已结课数据，隐藏但保留可查阅 |
| 系统配置 | 维护平台公告、使用指南、毕设模块开关等键值配置 |

---

## 快速开始

前置要求：Node.js 18+、pnpm。

### 后端

```bash
cd backend
pnpm install

cp .env.example .env        # 至少填写 JWT_SECRET
# 本地开发使用 SQLite 文件，保持 DATABASE_URL="file:./dev.db"

pnpm run db:push            # 建表
pnpm run db:seed            # 创建管理员账号 admin / admin123
pnpm dev                    # tsx watch，默认端口 3001（可用 PORT 覆盖）
```

### 前端

```bash
cd frontend
pnpm install
pnpm dev                    # Vite 默认端口 5173，/api 已代理到 127.0.0.1:3001
```

浏览器打开 http://localhost:5173 ，用 `admin / admin123` 登录管理端。

初始化脚本还会创建一个只读测试账号 `test / test123`（VIEWER 角色），用于预览学生视角。

> 学生数据可通过管理端「用户管理」批量导入（支持下载模板）。毕设选题可用 `pnpm run import:thesis` 导入。

---

## 项目结构

```
vibesys/
├── backend/                  # Cloudflare Workers 后端
│   ├── src/
│   │   ├── index.ts          # Node 入口（本地开发）
│   │   ├── worker.ts         # Workers 入口（生产）
│   │   ├── app.factory.ts    # 共用应用装配
│   │   ├── routes/           # 9 个路由模块，70+ 接口端点
│   │   ├── services/         # AI 生成、Provider 解析、统计
│   │   ├── middleware/       # JWT 鉴权、封禁拦截、限流
│   │   └── generated/        # Prisma 客户端（生成产物，勿手动修改）
│   ├── tests/                # Vitest 单元与集成测试（集成测试真实连库 + 起 HTTP 服务）
│   ├── prisma/schema.prisma  # 数据模型
│   └── wrangler.toml         # Workers 配置
├── frontend/                 # Vue 3 前端
│   └── src/
│       ├── views/            # 页面（含 admin/ 与 graduation/ 子目录）
│       ├── __tests__/        # Vitest 用例（jsdom 环境）
│       └── api/  stores/  router/  components/
├── docs/superpowers/         # 设计文档与实施计划
├── .planning/                # 阶段规划与状态追踪
├── AGENTS.md                 # 协作约定与架构说明
└── VibeCoding教学实践平台-PRD文档.md
```

### 架构约定

- 请求链路为 **Route → Service → Prisma**，路由层只做参数校验与鉴权。
- 本地开发走 `tsx` + SQLite 文件，生产走 Workers + D1，两端共用 `app.factory.ts` 装配，避免行为漂移。
- 所有 AI 生成方法接收 `userId`，用于解析该用户实际可用的模型配置。

---

## 环境变量

### 后端（`backend/.env`）

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 本地 `file:./dev.db`；生产由 D1 绑定提供 |
| `JWT_SECRET` | 会话签名密钥，**生产环境必须为长随机串** |
| `NODE_ENV` | `development` / `production` |
| `FRONTEND_URL` | CORS 允许来源，多域名用逗号分隔 |
| `MINIMAX_BASE_URL` | AI 兜底服务地址 |
| `MINIMAX_MODEL` | AI 兜底模型名 |
| `MINIMAX_API_KEY` | AI 兜底密钥 |

AI 配置按三级优先级解析：**学生个人设置 → 管理员启用的 Provider → 环境变量兜底**。

### 前端（`frontend/.env.production`）

| 变量 | 说明 |
|---|---|
| `VITE_API_BASE_URL` | 生产环境 API 地址，本地开发留空走 Vite 代理 |

---

## 部署

| 组件 | 目标 | 触发方式 |
|---|---|---|
| 后端 | Cloudflare Workers | 推送到 `main` 且改动 `backend/**` 时由 GitHub Actions 自动部署 |
| 数据库 | Cloudflare D1 | `wrangler d1` 命令手动执行迁移 |
| 前端 | Cloudflare Pages | 连接仓库，根目录 `frontend`，构建命令 `pnpm build`，产物目录 `dist` |

自动部署依赖仓库 Secret `CLOUDFLARE_API_TOKEN`。前端部署前需确保 `frontend/.env.production` 中的 `VITE_API_BASE_URL` 指向正确的后端域名。

---

## 相关文档

| 文档 | 内容 |
|---|---|
| [AGENTS.md](./AGENTS.md) | 架构约定、目录职责、开发规范 |
| [PRD 文档](./VibeCoding教学实践平台-PRD文档.md) | 产品需求、文档模板结构、评分标准 |
| [CLAUDE.md](./CLAUDE.md) | AI 编码工具协作说明 |
| [docs/superpowers/](./docs/superpowers/) | 各功能的设计文档与实施计划 |
| [.planning/](./.planning/) | 阶段路线图与完成状态 |

---

## 贡献

提交前请先跑通本仓库的质量门，CI 会做同样的检查：

```bash
# 后端：类型检查（源码 + 测试）、单元与集成测试
cd backend  && pnpm typecheck && pnpm test

# 前端：类型检查（应用 + 测试）、用例、构建
cd frontend && pnpm typecheck && pnpm test && pnpm build
```

后端集成测试会真实连接 SQLite 并起 HTTP 服务，需要 `backend/.env` 中配置好
`DATABASE_URL` 与 `JWT_SECRET`，并已执行 `pnpm db:push` 建库。测试数据在
`afterEach` 中自行清理，不会污染开发库。

- 提交 Issue 请使用 [Bug 报告](.github/ISSUE_TEMPLATE/bug_report.yml) 或 [功能建议](.github/ISSUE_TEMPLATE/feature_request.yml) 模板。
- 提交 PR 请按 [PR 模板](.github/pull_request_template.md) 填写改动类型、影响范围与自检清单。
- 改动 `backend/prisma/schema.prisma` 后需执行 `pnpm db:generate`，并同步提交 `backend/src/generated/prisma/` 下重新生成的产物（本仓库按约定将生成产物入库，供部署直接使用）。
- 不要提交任何明文密钥：`.env`、`.dev.vars` 等已在 `.gitignore` 中排除。

> 测试覆盖仍在补齐中。`backend/tests/ai.test.ts`、`document.test.ts`、
> `project.test.ts` 中的用例以 `it.todo` 显式标记（未实现），不会计入通过数；
> 补齐后请把 `it.todo` 改为 `it` 并补上真实断言。

---

## 许可

[MIT](./LICENSE) © 2026 liuxm2011
