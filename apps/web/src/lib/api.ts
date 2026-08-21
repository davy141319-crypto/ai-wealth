import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { authCoordinator } from '@/auth/AuthSessionCoordinator';
import { extractReason, isSessionInvalidationReason } from './auth-reasons';

/**
 * Pre-configured Axios client for the API. Base URL comes from
 * NEXT_PUBLIC_API_URL (public, safe to expose in the browser).
 *
 * P1-003: `withCredentials: true` so the browser sends the HttpOnly
 * access-token cookie and the CSRF cookie on cross-origin requests to the API
 * (CORS is whitelisted to WEB_APP_URL / ADMIN_APP_URL on the server).
 *
 * P1-005: 装 401/403 response 拦截器 → 调 AuthSessionCoordinator。
 * - 401（非 /auth/* 请求）→ Coordinator.handleUnauthorized(原请求配置)
 *   Coordinator 完成 single-flight refresh + /auth/me 判定后，由本拦截器重试原请求。
 * - 403 仅当 error.details.reason 属于会话失效原因（REFRESH_TOKEN_REUSED/REVOKED 等）
 *   才 Coordinator.handleForbidden()（清会话 + 回登录）；普通业务 403 原样 reject，
 *   保持 authenticated（Fix 2）。
 *
 * ⚠️ 强制约束 B：本实例仅供业务请求使用；Coordinator/SiweWalletClient 必须用 authApi
 *    （无 401 拦截器），否则会形成 api.ts → Coordinator → siwe-client → api.ts 循环。
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});

/** 判断请求 URL 是否为 /auth/*（这些请求走 authApi，不应触发本拦截器的 refresh 逻辑）。 */
function isAuthRequest(config?: AxiosRequestConfig): boolean {
  const url = config?.url ?? '';
  return url.startsWith('/auth/') || url.startsWith('auth/');
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const originalRequest = error.config;

    // 403 仅会话失效原因才清会话；普通业务 403 原样 reject，保持 authenticated（Fix 2）
    if (status === 403) {
      if (isSessionInvalidationReason(extractReason(error))) {
        authCoordinator.handleForbidden();
      }
      return Promise.reject(error);
    }

    // 401 → 经 Coordinator single-flight refresh + 重试
    if (status === 401 && originalRequest && !isAuthRequest(originalRequest)) {
      // 标记避免同一次请求被拦截器重复处理
      const retried = originalRequest as AxiosRequestConfig & { _p1005Retried?: boolean };
      if (retried._p1005Retried) {
        // 已经重试过一次仍 401 → 不再 refresh，reject
        return Promise.reject(error);
      }
      const { retried: refreshed } = await authCoordinator.handleUnauthorized(originalRequest);
      if (refreshed) {
        retried._p1005Retried = true;
        // 重试原请求（带新 access cookie，浏览器自动携带）
        return api.request(originalRequest);
      }
      // 会话失效，Coordinator 已广播 unauthenticated → reject
      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);
