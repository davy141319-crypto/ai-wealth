import axios from 'axios';

/** Pre-configured Axios client for the API (admin). */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:4000/api',
  timeout: 15_000,
});
