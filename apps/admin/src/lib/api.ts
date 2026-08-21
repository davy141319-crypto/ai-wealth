import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { authCoordinator } from '@/auth/AuthSessionCoordinator';
import { extractReason, isSessionInvalidationReason } from './auth-reasons';

/**
 * Admin business 403 callback. Registered by useAdmin hook at mount via setter.
 * When any /admin/* axios request returns 403 (non-session-invalidation reason),
 * this callback is invoked to transition AdminRoleState → FORBIDDEN.
 * api.ts MUST NOT import React / useAdmin; this mutable callback breaks the cycle.
 *
 * NOTE: In ESM, `export let` references are read-only on the importer side. The
 * internal `registerAdminForbiddenCallback` mutator is exposed so the useAdmin hook
 * can register without triggering TS2540.
 */
export let onAdminBusiness403: (() => void) | undefined;
/** Internal mutator (ESM-compliant) for useAdmin hook registration. */
export function registerAdminForbiddenCallback(cb: (() => void) | undefined): void {
  onAdminBusiness403 = cb;
}

/** 判断请求 URL 是否为 /auth/*（这些请求走 authApi，不应触发 refresh 逻辑）。 */
function isAuthRequest(config?: AxiosRequestConfig): boolean {
  const url = config?.url ?? '';
  return url.startsWith('/auth/') || url.startsWith('auth/');
}

/** 判断请求 URL 路径是否为 /admin/*（ADMIN-SPECIFIC 403 规则）。 */
function isAdminRoleRequest(config?: AxiosRequestConfig): boolean {
  const url = config?.url ?? '';
  const pathOnly = url.split('?')[0];
  return pathOnly.startsWith('/admin/') || pathOnly.startsWith('admin/');
}

/**
 * Pre-configured Axios client for Admin business requests.
 * Vite env: import.meta.env.VITE_API_URL.
 * withCredentials + interceptors (401 single-flight refresh / 403 reason dispatch).
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const status = error.response?.status;
    const originalRequest = error.config;

    // 403 handling
    if (status === 403) {
      const reason = extractReason(error);
      if (isSessionInvalidationReason(reason)) {
        // Session invalidation reason → clear session + unauthenticated
        authCoordinator.handleForbidden();
      } else if (originalRequest && isAdminRoleRequest(originalRequest)) {
        // ADMIN-SPECIFIC: 403 on /admin/* URLs, NOT a session-invalidation reason.
        // Notify useAdmin hook → FORBIDDEN role state. Keep session authenticated.
        if (onAdminBusiness403) onAdminBusiness403();
      }
      return Promise.reject(error);
    }

    // 401 → single-flight refresh + retry (skip /auth/* requests)
    if (status === 401 && originalRequest && !isAuthRequest(originalRequest)) {
      const retried = originalRequest as AxiosRequestConfig & { _p1005Retried?: boolean };
      if (retried._p1005Retried) {
        authCoordinator.handleForbidden();
        return Promise.reject(error);
      }
      const { retried: refreshed } = await authCoordinator.handleUnauthorized(originalRequest);
      if (refreshed) {
        retried._p1005Retried = true;
        return api.request(originalRequest);
      }
      authCoordinator.handleForbidden();
      return Promise.reject(error);
    }

    // 5xx → retry up to 3 times
    if (originalRequest && status !== undefined && status >= 500 && status < 600) {
      const req = originalRequest as AxiosRequestConfig & {
        _p1007RetryCount?: number;
      };
      const attempt = (req._p1007RetryCount ?? 0) + 1;
      if (attempt <= 3) {
        req._p1007RetryCount = attempt;
        return api.request(originalRequest);
      }
    }

    return Promise.reject(error);
  },
);
