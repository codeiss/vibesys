import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { getRequestListener } from '@hono/node-server';
import { test, beforeAll, afterAll, afterEach, expect } from 'vitest';
import { PrismaClient, Role, Status, type User } from '../src/generated/prisma';

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
let hashPassword: (password: string) => Promise<string>;
let adminDefaultPassword: string;

const createdUserIds = new Set<number>();

beforeAll(async () => {
  const indexModule = await import('../src/index.js');
  prisma = indexModule.prisma;

  const jwtModule = await import('../src/utils/jwt.utils.js');
  signToken = jwtModule.signToken as JwtSigner;
  jwtSecret = process.env.JWT_SECRET!;

  const passwordModule = await import('../src/utils/password.utils.js');
  hashPassword = passwordModule.hashPassword as (password: string) => Promise<string>;
  adminDefaultPassword = passwordModule.ADMIN_DEFAULT_PASSWORD as string;

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

async function createUser(options: {
  role: Role;
  label: string;
  passwordMode?: 'studentId' | 'adminDefault' | 'custom';
  customPassword?: string;
}): Promise<User> {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 5);
  const majorCode = options.role === Role.ADMIN ? '11' : '13';
  const studentId = `23${majorCode}${suffix}`;
  const passwordMode =
    options.passwordMode ||
    (options.role === Role.ADMIN ? 'adminDefault' : 'studentId');

  let plainPassword = studentId;
  if (passwordMode === 'adminDefault') {
    plainPassword = adminDefaultPassword;
  } else if (passwordMode === 'custom') {
    plainPassword = options.customPassword || `pw-${suffix}`;
  }

  const user = await prisma.user.create({
    data: {
      studentId,
      name: `${options.label}-${suffix}`,
      major: options.role === Role.ADMIN ? '软件工程' : '大数据',
      grade: '2026级',
      class: '2601',
      password: await hashPassword(plainPassword),
      // 与 src/routes/auth.routes.ts / admin.routes.ts 的写入保持一致：
      // 只有默认密码（学号 / 管理员默认）才置 true。管理员接口据此标记
      // 决定是否可回显明文，夹具不置 false 会让 CUSTOM 用户被误判为 DEFAULT。
      passwordIsDefault: passwordMode !== 'custom',
      role: options.role,
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

test('student can change their own password and log in with the new password', async () => {
  const student = await createUser({ role: Role.STUDENT, label: 'Student' });
  const cookie = await authCookie(student);
  const nextPassword = 'new-pass-123';

  const changeResponse = await requestJson('/api/auth/password', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({
      currentPassword: student.studentId,
      newPassword: nextPassword
    })
  });

  expect(changeResponse.status).toBe(200);
  expect(changeResponse.body.message).toBe('密码修改成功');

  const oldLogin = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: student.studentId,
      password: student.studentId
    })
  });
  expect(oldLogin.status).toBe(401);

  const newLogin = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: student.studentId,
      password: nextPassword
    })
  });
  expect(newLogin.status).toBe(200);
  expect(newLogin.body.user.studentId).toBe(student.studentId);
});

test('admin can inspect password state and reset student password to default', async () => {
  const admin = await createUser({ role: Role.ADMIN, label: 'Admin' });
  const student = await createUser({
    role: Role.STUDENT,
    label: 'ChangedStudent',
    passwordMode: 'custom',
    customPassword: 'custom-pass-1'
  });

  const adminCookie = await authCookie(admin);

  const defaultStudent = await createUser({ role: Role.STUDENT, label: 'DefaultStudent' });
  const userList = await requestJson(`/api/admin/users?page=1&pageSize=50&search=${defaultStudent.studentId}`, {
    headers: { Cookie: adminCookie }
  });

  expect(userList.status).toBe(200);
  const listedUser = userList.body.users.find((item: any) => item.id === defaultStudent.id);
  expect(listedUser).toBeTruthy();
  expect(listedUser.passwordStatus).toBe('DEFAULT');
  expect(listedUser.revealedPassword).toBe(defaultStudent.studentId);

  const passwordInfo = await requestJson(`/api/admin/users/${student.id}/password`, {
    headers: { Cookie: adminCookie }
  });
  expect(passwordInfo.status).toBe(200);
  expect(passwordInfo.body.passwordStatus).toBe('CUSTOM');
  expect(passwordInfo.body.revealedPassword).toBe(null);

  const resetResponse = await requestJson(`/api/admin/users/${student.id}/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie
    },
    body: JSON.stringify({ action: 'RESET_TO_DEFAULT' })
  });

  expect(resetResponse.status).toBe(200);
  expect(resetResponse.body.passwordStatus).toBe('DEFAULT');
  expect(resetResponse.body.revealedPassword).toBe(student.studentId);

  const loginAfterReset = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: student.studentId,
      password: student.studentId
    })
  });

  expect(loginAfterReset.status).toBe(200);
});

test('admin can set a custom password for a student', async () => {
  const admin = await createUser({ role: Role.ADMIN, label: 'AdminSetter' });
  const student = await createUser({ role: Role.STUDENT, label: 'StudentSetter' });
  const adminCookie = await authCookie(admin);
  const customPassword = 'teacher-set-123';

  const updateResponse = await requestJson(`/api/admin/users/${student.id}/password`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Cookie: adminCookie
    },
    body: JSON.stringify({
      action: 'SET_CUSTOM',
      newPassword: customPassword
    })
  });

  expect(updateResponse.status).toBe(200);
  expect(updateResponse.body.passwordStatus).toBe('CUSTOM');
  expect(updateResponse.body.revealedPassword).toBe(customPassword);

  const loginResponse = await requestJson('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      studentId: student.studentId,
      password: customPassword
    })
  });

  expect(loginResponse.status).toBe(200);
  expect(loginResponse.body.user.name).toBe(student.name);
});
