# VibeCoding 教学实践平台 — AGENTS.md

学生自主式软件开发实践平台。学生通过选题 → AI生成PRD → AI生成技术文档 → 外部AI编码工具开发的完整流程。

---

## Tech Stack

- **Frontend:** Vue 3 + TypeScript + Vite + Element Plus + Pinia + Tailwind CSS
- **Backend:** Cloudflare Workers + Hono + Cloudflare D1 (SQLite) + Prisma (@prisma/adapter-d1) + JWT
- **AI:** 多层优先级：用户个人设置 → 管理员活跃 Provider → 环境变量
- **Deploy:** Cloudflare Workers (后端) + Cloudflare Pages (前端)，域名 vibesys.7878.cloud

---

## Quick Start

```bash
# Backend (Cloudflare Workers)
cd backend && pnpm install
cp .env.example .env  # fill DATABASE_URL (file:./dev.db for local), JWT_SECRET
pnpm run db:push       # prisma db push (creates SQLite tables)
pnpm run db:seed       # creates admin/admin123
pnpm dev               # tsx watch src/index.ts → port 3001

# Frontend (separate terminal)
cd frontend && pnpm install
pnpm dev               # vite → port 5173, proxies /api → 3001
```

**Ports:** Backend 3001 (tsx dev server), Frontend 5173, D1 (SQLite, local file).

---

## Key Architecture

### Route → Service → Prisma

```
backend/src/routes/         # Hono routers with authMiddleware
  auth.routes.ts            # /api/auth/*
  topics.routes.ts          # /api/topics/*
  projects.routes.ts        # /api/projects/*
  ai.routes.ts              # /api/ai/* (document generation)
  documents.routes.ts       # /api/documents/*
  graduation.routes.ts      # /api/graduation/* (毕设文档)
  thesis.routes.ts          # /api/thesis/* (毕设选题)
  user.routes.ts            # /api/user/* (personal API settings)
  admin.routes.ts           # /api/admin/* (30+ endpoints)

backend/src/services/
  apiProvider.service.ts    # Provider priority resolver + CRUD
  ai.service.ts             # All AI generation (2778 lines)
  graduation.service.ts     # Graduation doc generation

backend/src/middleware/
  auth.middleware.ts        # JWT from httpOnly cookie → req.user
  ban.middleware.ts         # Check user not BANNED
  rate-limit.middleware.ts  # loginLimiter(5/min), generalLimiter(100/15min), aiLimiter(10/hr)
```

### Auth Flow

- JWT stored in **httpOnly cookie** (not localStorage)
- `auth.store.ts` (Pinia) manages user state
- `router/guards.ts`: `beforeEach` checks `requiresAuth`/`requiresAdmin`, restores session via `fetchProfile()` on refresh
- `authMiddleware` sets `req.user = { userId, role, ... }`

### AI Provider Priority

```
getConfigForUser(userId) in apiProvider.service.ts:
  1. UserApiSetting table (if user configured personal key) — highest
  2. ApiProvider table (admin-configured, isActive=true) — middle
  3. Environment variables (MINIMAX_*) — lowest
```

Every `ai.service.ts` / `graduation.service.ts` method accepts `userId?: number`; pass it for per-user config resolution.

### Document Generation Order (Strict)

```
PRD → FRONTEND → BACKEND → API → TASK → CONTEXT_STATE → AGENTS
```

Each doc type depends on previous docs for context. Generation prompt templates in `backend/src/prompts/*.template.ts` (11 templates).

### Database

- Prisma + Cloudflare D1 (SQLite) (`@prisma/adapter-d1`)
- Key models: `User`, `Topic`, `Project`, `Document` (7 doc types), `GraduationDocument` (6 types), `UserApiSetting`, `ApiProvider`, `SystemConfig`, `AiUsageLog`, `ThesisTopic`, `ThesisProject`, `ArchivedGrade`, `ArchivedThesisProject`
- `prisma db seed` = `tsx src/scripts/init-admin.ts`
- `@@unique([projectId, docType])` — one doc per type per project
- **D1 变更规范：** 修改 schema 后必须先手动 `ALTER TABLE` 到生产 D1，再 push 代码部署 Worker（详见下方 D1 数据库变更规范）

---

## Build / Test / Verify

```bash
# Backend typecheck (no build needed — tsx runs TS directly)
cd backend && pnpm exec tsc --noEmit

# Backend tests (vitest)
cd backend && npx vitest run

# Frontend typecheck + build
cd frontend && pnpm run build   # runs vue-tsc -b && vite build

# Frontend tests (vitest, jsdom)
cd frontend && npx vitest run
```

- Frontend `tsconfig.json` has `noUnusedLocals: true`, `noUnusedParameters: true` — strict
- Frontend test setup only mocks Element Plus; no actual test files exist yet
- Backend test setup is minimal (`beforeAll`/`afterAll` connect/disconnect); integration tests need real DB
- Both sides use `vitest.config.ts`

---

## Vite Proxy — SSE Handling

`frontend/vite.config.ts` has special proxy config for SSE streams:

| Path | Timeout | Notes |
|------|---------|-------|
| `/api/ai/generate/stream` | 180s | `Connection: keep-alive`, `X-Accel-Buffering: no` |
| `/api/ai/review/stream` | 600s | Same headers, 10min for expert panel review |
| `/api` (general) | default | No special headers |

The SSE proxy config must be duplicated for each streaming endpoint — the `/api` catch-all proxy does not inherit SSE headers.

---

## Production Deployment (Cloudflare)

| Item | Value |
|------|-------|
| Domain | `https://vibesys.7878.cloud` |
| Backend | Cloudflare Workers (`api.7878.cloud` route) |
| Frontend | Cloudflare Pages (`vibesys.pages.dev` 或自定义域名) |
| Database | Cloudflare D1 (`vibesysdb`, ID: `eb62d282-41e8-4e75-af08-5ef3e2b6da59`) |
| CI/CD | GitHub Actions (`.github/workflows/deploy.yml`) — push `backend/**` to `main` auto deploys Worker |
| Config | `backend/wrangler.toml` (Worker config), `frontend/` (Pages auto-detects Vite) |

**Deploy flow:**

```bash
# 1. Local verify
cd backend && npx tsc --noEmit
cd ../frontend && pnpm run build

# 2. If schema changed: D1 migration BEFORE push (CRITICAL!)
cd backend
npx wrangler d1 execute vibesysdb --remote --command="ALTER TABLE \"TableName\" ADD COLUMN \"newColumn\" TEXT;"

# 3. Commit + push (triggers CI/CD)
git add -A && git commit -m '...' && git push origin main
# → GitHub Actions deploys Worker automatically
# → Frontend deploys via Pages (push to main or PR)
```

**Never** commit `.env` files or secrets. Use `wrangler secret put` for sensitive vars (e.g., `COOLIFY_API_TOKEN`, `JWT_SECRET`).

**Health check:** `curl -fsS https://api.7878.cloud/api/health` → `{"status":"ok",...}`

### D1 数据库变更规范

**重要：每次修改 Prisma schema 后必须手动迁移 D1，CI/CD 不会自动执行。**

**正确流程：**
1. 修改 `backend/prisma/schema.prisma`
2. 运行本地迁移生成 SQL：
   ```bash
   cd backend && DATABASE_URL="file:./dev.db" npx prisma migrate dev --name <描述>
   ```
3. **立即**将 `ALTER TABLE` 应用到生产 D1（**在 push 代码之前**）：
   ```bash
   cd backend && npx wrangler d1 execute vibesysdb --remote --command="ALTER TABLE \"Project\" ADD COLUMN \"newField\" TEXT;"
   ```
4. 再 push 代码 → CI/CD 部署 Worker

**为什么顺序重要：**
CI/CD 在 push 后立即部署新 Worker，新 Worker 里的 Prisma client 已包含新字段。若 D1 还没有该列，**所有涉及该表的查询都会 500**，影响所有在线用户。必须先改 D1，再部署 Worker。

**注意事项：**
- `prisma migrate dev` 生成的迁移 SQL 可能是**完整重建表**（含 DROP TABLE），**不能直接在生产 D1 执行**，会丢失数据。生产只用 `ALTER TABLE ... ADD COLUMN` 方式增量变更。

---

## Framework Quirks & Gotchas

1. **Cloudflare Workers runtime:** Backend runs on Workers, not Node.js. Use `fetch()` not `axios`, no `fs` module, no `process.env` (use `c.env` from Hono context)
2. **Prisma + D1:** Uses `@prisma/adapter-d1` adapter. Prisma client generated to `backend/src/generated/prisma/` and **committed to git**
3. **Worker entry point:** `backend/src/worker.ts` exports default Hono app (`export default app`), not `index.ts`
4. **Local dev:** `pnpm dev` runs `tsx watch src/index.ts` on port **3001** (Node, not Workers). Only `wrangler dev` / deploy uses the Workers runtime via `worker.ts`
5. **D1 migration order:** MUST run `ALTER TABLE` on production D1 **BEFORE** pushing code, otherwise 500 errors for all users
6. **Admin routes are monolithic:** `admin.routes.ts` is 1507 lines with all admin CRUD in one file
7. **`ai.service.ts` is monolithic:** 2473 lines with all generation/review/fix methods
8. **Menu order in schema:** `@@index([key])` is listed after fields but before closing `}` — Prisma syntax
9. **`ban.middleware.ts` is imported but checkBannedMiddleware is not a route-level middleware in most routes** — the service file imports it but routes use it only in specific admin endpoints
10. **Planning docs are out of date** (`STATE.md`, `ROADMAP.md` say all phases complete, but features like graduation documents, user API settings, AI providers were added after)
11. **`AGENTS.md` and `CLAUDE.md` are siblings:** Both exist at root; `CLAUDE.md` has deployment details. The `AGENTS.md` is the canonical one

---

## Project Layout

```
backend/                  # Cloudflare Workers API server
  prisma/schema.prisma    # 13 models + 9 enums (318 lines)
  wrangler.toml           # Worker config (name, routes, D1 binding, vars)
  src/
    worker.ts             # Worker entry: exports default Hono app
    app.factory.ts        # Creates Hono app with routes + middleware
    routes/               # 9 route files
    services/             # ai.service.ts (2473 lines), apiProvider, graduation, coolify
    prompts/              # 11 prompt templates
    middleware/           # auth, ban, rate-limit
    lib/                  # prisma.ts (D1 adapter), logger.ts
    utils/                # jwt, password, excel-import
    scripts/              # init-admin.ts, update-passwords.ts, import-thesis-topics.ts, mysql-to-d1.ts
    generated/prisma/     # Generated Prisma client (COMMITTED to git)
  tests/                  # Test files (node:test)
frontend/                 # Vue 3 SPA (Cloudflare Pages)
  src/
    api/                  # 9+ API client modules
    stores/               # 7 Pinia stores
    views/                # 7 pages + admin/ subfolder + graduation/
    router/               # index.ts + guards.ts
    components/           # Shared Vue components (incl. ArchiveDeployPanel)
    constants/            # tech-options.ts
    utils/                # Utilities
    __tests__/            # setup.ts only
```

---

## What This File Does NOT Cover

- Individual page/component specifics (the codebase is straightforward Vue SFC)
- Generic Vue/TypeScript best practices (follow framework defaults)
- GSD phase workflow (planning system is dormant — all 5 phases complete)
- CSS/styling conventions (custom vars in `App.vue`, Element Plus overrides)
