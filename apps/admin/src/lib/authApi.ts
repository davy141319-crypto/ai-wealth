import axios from 'axios';

/**
 * P1-007 Admin: auth-only axios instance (no 401 interceptor).
 * Vite env: import.meta.env.VITE_API_URL.
 *
 * 该实例仅供 SiweWalletClient / AuthSessionCoordinator 使用；
 * 业务请求必须用 api.ts（带拦截器）。
 */
export const authApi = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';
