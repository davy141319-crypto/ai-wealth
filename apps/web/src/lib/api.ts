import axios from 'axios';

/**
 * Pre-configured Axios client for the API. Base URL comes from
 * NEXT_PUBLIC_API_URL (public, safe to expose in the browser).
 */
export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
});
