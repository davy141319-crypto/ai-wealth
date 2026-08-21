// ============================================================================
// P1-007 Admin — siwe-client.ts
//
// Admin-side SIWE client. Vite SPA CSR-only.
// Environment: VITE_API_URL via import.meta.env.
// ============================================================================

import type { Address, Chain as ViemChain, Hash } from 'viem';
import type { AxiosInstance } from 'axios';
import { authApi as defaultApi } from './authApi';

const CSRF_HEADER = 'X-CSRF-TOKEN';
const TRANSPORT_HEADER = 'X-Auth-Transport';
const TRANSPORT_COOKIE = 'cookie';

interface ApiResponseEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { message?: string };
}

export interface NonceResponse {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  domain: string;
  uri: string;
  statement?: string;
  chainId: number;
}

export interface VerifyResponseUser {
  id: string;
  status: string;
  lastLoginAt: string | null;
  wallets: Array<{
    id: string;
    address: string;
    chain: string;
    network: string;
    status: string;
    isPrimary: boolean;
  }>;
}

export interface VerifyResponse {
  accessToken?: string;
  refreshToken?: string;
  user: VerifyResponseUser;
}

export interface LoginConnector {
  connect(): Promise<{ address: Address; chainId: number }>;
  signMessage(message: string): Promise<`0x${string}`>;
  resolveChain(chainId: number): { chain: string; network: string } | null;
}

export function buildSiweMessage(params: {
  domain: string;
  address: Address;
  uri: string;
  chainId: number;
  nonce: string;
  statement?: string;
  issuedAtIso?: string;
  expirationTimeIso?: string;
  version?: '1';
  notBeforeIso?: string;
  requestId?: string;
  resources?: string[];
}): string {
  const issuedAt = params.issuedAtIso ?? new Date().toISOString();
  const expirationTime =
    params.expirationTimeIso ?? new Date(Date.now() + 10 * 60_000).toISOString();
  const head =
    `${params.domain} wants you to sign in with your Ethereum account:\n` + `${params.address}\n`;
  const statement = params.statement ? `${params.statement}\n` : '';
  const body =
    `\nURI: ${params.uri}\nVersion: ${params.version ?? '1'}\n` +
    `Chain ID: ${params.chainId}\nNonce: ${params.nonce}\n` +
    `Issued At: ${issuedAt}\nExpiration Time: ${expirationTime}`;
  const tail: string[] = [];
  if (params.notBeforeIso) tail.push(`Not Before: ${params.notBeforeIso}`);
  if (params.requestId) tail.push(`Request ID: ${params.requestId}`);
  if (params.resources?.length) {
    tail.push(`Resources:\n- ${params.resources.join('\n- ')}`);
  }
  return head + statement + body + (tail.length ? '\n' + tail.join('\n') : '');
}

const CHAIN_TO_BACKEND: Record<number, { chain: string; network: string }> = {
  1: { chain: 'ETH', network: 'mainnet' },
  11155111: { chain: 'ETH', network: 'sepolia' },
  56: { chain: 'BSC', network: 'mainnet' },
  97: { chain: 'BSC', network: 'testnet' },
  137: { chain: 'POLYGON', network: 'mainnet' },
  80001: { chain: 'POLYGON', network: 'mumbai' },
  42161: { chain: 'ARBITRUM', network: 'mainnet' },
  421613: { chain: 'ARBITRUM', network: 'goerli' },
};

export class SiweWalletClient {
  private csrfToken: string | undefined;
  private connector: LoginConnector | undefined;

  constructor(
    connector?: LoginConnector,
    private readonly http: AxiosInstance = defaultApi,
    private readonly session: { token?: string } = {},
  ) {
    this.connector = connector;
  }

  setConnector(connector: LoginConnector): void {
    this.connector = connector;
  }

  get token(): string | undefined {
    return this.session.token;
  }

  clearSession(): void {
    this.session.token = undefined;
    this.csrfToken = undefined;
  }

  private async get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    const r = await this.http.get(path, { params });
    return r.data.success ? r.data.data : Promise.reject(new Error(r.data.error?.message ?? path));
  }

  private async ensureCsrfToken(): Promise<void> {
    if (this.csrfToken) return;
    const r = await this.http.get<ApiResponseEnvelope<{ csrfToken: string }>>('/auth/csrf-token');
    this.csrfToken = r.data.success ? r.data.data!.csrfToken : undefined;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    await this.ensureCsrfToken();
    const headers: Record<string, string> = {
      [TRANSPORT_HEADER]: TRANSPORT_COOKIE,
    };
    if (this.csrfToken) headers[CSRF_HEADER] = this.csrfToken;
    if (this.session.token) {
      headers.Authorization = `Bearer ${this.session.token}`;
    }
    const r = await this.http.post(path, body, { headers });
    return r.data.success ? r.data.data : Promise.reject(new Error(r.data.error?.message ?? path));
  }

  async me(): Promise<VerifyResponseUser> {
    const headers: Record<string, string> = this.session.token
      ? { Authorization: `Bearer ${this.session.token}` }
      : {};
    const r = await this.http.get<ApiResponseEnvelope<VerifyResponseUser>>('/auth/me', { headers });
    return r.data.success
      ? r.data.data!
      : Promise.reject(new Error(r.data.error?.message ?? '/auth/me'));
  }

  async logout(): Promise<{ loggedOut: boolean }> {
    const res = await this.post<{ loggedOut: boolean }>('/auth/logout', {});
    this.clearSession();
    return res;
  }

  async login(requestId?: string): Promise<{ token?: string; user: VerifyResponseUser }> {
    if (!this.connector) {
      throw new Error('LoginConnector not set; call setConnector() before login()');
    }
    const { address, chainId } = await this.connector.connect();
    const chain = this.connector.resolveChain(chainId) ?? CHAIN_TO_BACKEND[chainId];
    if (!chain) throw new Error(`unsupported chain id: ${chainId}`);

    const nonceData = await this.get<NonceResponse>('/auth/nonce', {
      address,
      chain: chain.chain,
      network: chain.network,
    });
    if (nonceData.chainId !== chainId) {
      throw new Error(`nonce chainId ${nonceData.chainId} mismatches wallet chainId ${chainId}`);
    }
    const message = buildSiweMessage({
      domain: nonceData.domain,
      address,
      uri: nonceData.uri,
      chainId: nonceData.chainId,
      nonce: nonceData.nonce,
      statement: nonceData.statement,
      requestId,
    });
    const signature = await this.connector.signMessage(message);
    const resp = await this.post<VerifyResponse>('/auth/verify', {
      message,
      signature,
      address,
      chain: chain.chain,
      network: chain.network,
    });
    this.session.token = resp.accessToken;
    return { token: resp.accessToken, user: resp.user };
  }

  async refresh(): Promise<{ user: VerifyResponseUser }> {
    const resp = await this.post<VerifyResponse>('/auth/refresh', {});
    return { user: resp.user };
  }
}

export type _HashAlias = Hash;
export type _ViemChainAlias = ViemChain;
