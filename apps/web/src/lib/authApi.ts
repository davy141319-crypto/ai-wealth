import axios from 'axios';

/**
 * P1-005: 独立的 auth-only axios 实例。
 *
 * 为什么单独开一个实例（而不是复用 api.ts）：
 *   业务 api.ts 装了 401 response interceptor，会调用 AuthSessionCoordinator
 *   去 refresh + 重试。如果 Coordinator 再用同一个 api.ts 发 /auth/refresh，
 *   就会形成循环：api.ts → Coordinator → refresh → api.ts(401) → Coordinator …
 *
 *   authApi 故意不装 401 interceptor，/auth/* 的 401 由 Coordinator 自行判定
 *   （409 → /auth/me 判定；401/403 → unauthenticated），不会回流到拦截器。
 *
 * baseURL 强制约束 A：必须与 api.ts 同源（`NEXT_PUBLIC_API_URL || 'http://localhost:4000/api'`），
 * 不得改成固定 `/api`（会导致跨环境部署失败）。
 *
 * 该实例仅供 SiweWalletClient / AuthSessionCoordinator 使用，业务请求必须用 api.ts。
 */
export const authApi = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});

/**
 * 共享的 baseURL 来源，供测试断言 authApi 与 api 同源（强制约束 A）。
 * 不要在运行时业务代码里直接读这个常量——用 `authApi.defaults.baseURL`
 * 或 `api.defaults.baseURL`。
 */
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
