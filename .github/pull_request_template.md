## 改动内容

<!-- 一句话说明这个 PR 做了什么 -->

## 关联 Issue

<!-- 例如：Closes #12 -->

## 改动类型

- [ ] 新功能
- [ ] 缺陷修复
- [ ] 重构 / 性能优化
- [ ] 文档
- [ ] 构建 / CI / 依赖

## 影响范围

- [ ] 前端（`frontend/`）
- [ ] 后端（`backend/`）
- [ ] 数据库 schema（`backend/prisma/schema.prisma`）
- [ ] 部署配置（`backend/wrangler.toml` / `.github/workflows/`）
- [ ] 仅文档，无代码改动

## 自检清单

- [ ] 后端类型检查通过：`cd backend && npx tsc --noEmit`
- [ ] 前端构建通过：`cd frontend && pnpm build`
- [ ] 改动了 `schema.prisma` 时，已执行 `pnpm db:generate` 并同步提交生成产物
      （`backend/src/generated/prisma/` 按约定入库，供部署直接使用）
- [ ] 未提交任何明文密钥（`.env` / `.dev.vars` 等，见 `.gitignore`）
- [ ] 行为有变化的改动，已同步更新 `README.md` 与 `AGENTS.md`

## 补充说明

<!-- 截图、接口变更、需要 reviewer 重点关注的地方 -->
