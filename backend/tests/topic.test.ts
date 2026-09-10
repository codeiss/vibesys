import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { test, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { PrismaClient, Role, Status, TopicType, type Topic, type User } from '../src/generated/prisma';

// signToken 是异步的，且必须显式传入 secret——签名与校验（auth.middleware.ts）
// 用的是同一个 JWT_SECRET，否则中间件取不到有效会话，一律 401。
// role 直接用 Prisma 的 Role 枚举（含 STUDENT / ADMIN / VIEWER），
// 避免与 signToken 的 JwtPayload 签名不一致。
type JwtSigner = (
  payload: {
    userId: number;
    studentId: string;
    name: string;
    role: Role;
  },
  secret: string
) => Promise<string>;

let server: Server;
let baseUrl: string;
let prisma: PrismaClient;
let signToken: JwtSigner;
let jwtSecret: string;

const createdTopicIds = new Set<number>();
const createdUserIds = new Set<number>();

beforeAll(async () => {
  const indexModule = await import('../src/index.js');
  prisma = indexModule.prisma;

  const jwtModule = await import('../src/utils/jwt.utils.js');
  signToken = jwtModule.signToken as JwtSigner;
  jwtSecret = process.env.JWT_SECRET!;

  // Hono 的 app 是对象而非 http 请求监听函数，必须经 getRequestListener 适配，
  // 否则服务虽能 listen，但请求不会得到任何响应（表现为测试挂起至超时）。
  server = createServer(getRequestListener(indexModule.app.fetch));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  if (createdTopicIds.size > 0) {
    await prisma.topic.deleteMany({
      where: {
        id: { in: Array.from(createdTopicIds) }
      }
    });
    createdTopicIds.clear();
  }

  if (createdUserIds.size > 0) {
    await prisma.user.deleteMany({
      where: {
        id: { in: Array.from(createdUserIds) }
      }
    });
    createdUserIds.clear();
  }
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

async function createUser(role: Role, label: string): Promise<User> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 5);
  const majorCode = role === Role.ADMIN ? '11' : '13';
  const studentId = `23${majorCode}${suffix}`;
  const user = await prisma.user.create({
    data: {
      studentId,
      name: `${label}-${suffix}`,
      major: role === Role.ADMIN ? '软件工程' : '大数据',
      grade: '2026级',
      class: '2601',
      password: 'test-password',
      role,
      status: Status.ACTIVE
    }
  });

  createdUserIds.add(user.id);
  return user;
}

async function authCookie(user: User): Promise<string> {
  const token = await signToken(
    {
      userId: user.id,
      studentId: user.studentId,
      name: user.name,
      role: user.role
    },
    jwtSecret
  );

  return `token=${token}`;
}

async function requestJson(
  url: string,
  options: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${url}`, options);
  const body = await response.json();
  return { status: response.status, body };
}

test('keeps custom topics private to the creator and read-only in admin topic management', async () => {
  const admin = await createUser(Role.ADMIN, 'Admin');
  const creator = await createUser(Role.STUDENT, 'Creator');
  const otherStudent = await createUser(Role.STUDENT, 'Other');

  const creatorCookie = await authCookie(creator);
  const otherCookie = await authCookie(otherStudent);
  const adminCookie = await authCookie(admin);

  const customTitle = `Custom Topic ${randomUUID().slice(0, 8)}`;

  const createResponse = await requestJson('/api/topics/custom', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: creatorCookie
    },
    body: JSON.stringify({
      title: customTitle,
      description: '这是用于验证自拟选题隐私范围的测试描述内容。',
      background: '测试背景',
      objectives: '测试目标',
      domain: 'SE',
      // platform 是必填项（topics.routes.ts 校验），且 techStack 至少 3 项
      platform: 'WEB',
      techStack: ['Vue 3', 'Node.js + Express', 'MySQL']
    })
  });

  expect(createResponse.status).toBe(200);
  expect(createResponse.body.topic.type).toBe(TopicType.CUSTOM);

  const customTopic = createResponse.body.topic as Topic;
  createdTopicIds.add(customTopic.id);

  const creatorTopics = await requestJson('/api/topics', {
    headers: { Cookie: creatorCookie }
  });
  expect(creatorTopics.status).toBe(200);
  expect(creatorTopics.body.topics.some((topic: Topic) => topic.id === customTopic.id)).toBe(true);

  const otherTopics = await requestJson('/api/topics', {
    headers: { Cookie: otherCookie }
  });
  expect(otherTopics.status).toBe(200);
  expect(otherTopics.body.topics.some((topic: Topic) => topic.id === customTopic.id)).toBe(false);

  const otherTopicDetail = await requestJson(`/api/topics/${customTopic.id}`, {
    headers: { Cookie: otherCookie }
  });
  expect(otherTopicDetail.status).toBe(404);

  // 管理端选题管理会同时展示内置与自拟选题（前端 TopicManagement.vue 提供
  // 「仅查看内置 / 仅查看自拟」筛选与类型标签），因此不带筛选时应能检索到自拟选题。
  const adminTopics = await requestJson('/api/admin/topics?page=1&pageSize=50', {
    headers: { Cookie: adminCookie }
  });
  expect(adminTopics.status).toBe(200);
  expect(adminTopics.body.topics.some((topic: Topic) => topic.id === customTopic.id)).toBe(true);

  const adminSystemFilter = await requestJson('/api/admin/topics?type=SYSTEM&page=1&pageSize=50', {
    headers: { Cookie: adminCookie }
  });
  expect(adminSystemFilter.status).toBe(200);
  expect(adminSystemFilter.body.topics.every((topic: Topic) => topic.type === TopicType.SYSTEM)).toBe(true);
  expect(adminSystemFilter.body.topics.some((topic: Topic) => topic.id === customTopic.id)).toBe(false);

  const adminCustomFilter = await requestJson('/api/admin/topics?type=CUSTOM&page=1&pageSize=50', {
    headers: { Cookie: adminCookie }
  });
  expect(adminCustomFilter.status).toBe(200);
  expect(adminCustomFilter.body.topics.every((topic: Topic) => topic.type === TopicType.CUSTOM)).toBe(true);
  expect(adminCustomFilter.body.topics.some((topic: Topic) => topic.id === customTopic.id)).toBe(true);

  const adminUpdate = await requestJson(`/api/admin/topics/${customTopic.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie
    },
    body: JSON.stringify({
      title: 'Blocked Update',
      description: '这是用于验证后台不能修改自拟选题的测试描述内容。',
      background: '测试背景',
      objectives: '测试目标',
      domain: 'SE',
      techStack: []
    })
  });
  expect(adminUpdate.status).toBe(404);

  const adminDelete = await requestJson(`/api/admin/topics/${customTopic.id}`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  expect(adminDelete.status).toBe(404);
});
