import axios from 'axios';

/**
 * Pre-configured Axios client for the API. Base URL comes from
 * NEXT_PUBLIC_API_URL (public, safe to expose in the browser).
 *
 * P1-003: `withCredentials: true` so the browser sends the HttpOnly
 * access-token cookie and the CSRF cookie on cross-origin requests to the API
 * (CORS is whitelisted to WEB_APP_URL / ADMIN_APP_URL on the server).
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});
