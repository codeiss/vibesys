// Vitest 全局初始化：加载 backend/.env 并把 NODE_ENV 固定为 test。
//
// 注意：这里不再创建 PrismaClient。src/index.ts 已经在模块加载时创建了
// 唯一的客户端实例并对外导出，各测试文件直接复用它即可——重复创建会导致
// 额外的数据库连接，且此前的实现从 '@prisma/client' 导入（本仓库的生成产物
// 实际位于 src/generated/prisma）会在运行时报 "did not initialize yet"。

import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

process.env.NODE_ENV = 'test';
