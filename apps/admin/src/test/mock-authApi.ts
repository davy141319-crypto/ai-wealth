/**
 * Jest-compatible authApi mock (Vite-free).
 * Replaces import.meta.env references with process.env so authApi.ts compiles
 * in Jest CJS mode.  This file is mapped in jest.config.js moduleNameMapper.
 */
import axios from 'axios';

export const authApi = axios.create({
  baseURL: (process.env.VITE_API_URL as string) || 'http://localhost:4000/api',
  timeout: 15_000,
  withCredentials: true,
});

export const API_BASE_URL = (process.env.VITE_API_URL as string) || 'http://localhost:4000/api';
