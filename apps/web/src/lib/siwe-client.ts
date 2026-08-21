// ============================================================================
// siwe-client.ts — Web-side helpers for the full SIWE login dance.
//
// Security (matches P1-002 NFRs):
//   - Private keys / seed phrases NEVER leave the client page.
//   - The server nonce is fetched fresh per login attempt.
//   - The message string is constructed HERE exactly as it will be signed;
//     the server re-validates domain / URI / chainId / issuedAt / exp.
//   - After verify success the JWT is stored in memory-only (not localStorage
//     nor cookie) per security guidance; caller can attach Bearer header.
//
// P1-003 (Cookie + CSRF):
//   - The axios client sends `withCredentials: true` so the HttpOnly access
//     cookie and the non-HttpOnly CSRF cookie travel with every request.
//   - State-changing requests (POST/PUT/PATCH/DELETE) attach the X-CSRF-TOKEN
//     header (Double Submit Cookie). The token is fetched lazily from
//     GET /auth/csrf-token on the first mutating call and cached in memory.
//   - The in-memory Bearer token is STILL set for backward compatibility —
//     the server treats Bearer as priority over Cookie when both are present.
//
// P1-004 (Refresh rotation + explicit transport):
//   - The browser declares `X-Auth-Transport: cookie` on verify / refresh /
//     logout so the server sets HttpOnly cookies (access + refresh) and NEVER
//     returns token plaintext in the body. The refresh token lives ONLY in the
//     HttpOnly refresh cookie — it is never read by JS, never put in localStorage
//     or a Bearer header, and never logged.
//   - `login()` therefore no longer relies on a body `accessToken`; the session
//     is carried by the access cookie. `accessToken` is kept OPTIONAL on the
//     response type for api/legacy callers.
//   - `refresh()` rotates the refresh cookie via POST /auth/refresh (empty body,
//     CSRF enforced). On 409 RETRY the access cookie may still be valid, so the
//     caller can retry once; on 401/403 the session is cleared and the user must
//     re-authenticate via SIWE.
//
// Usage:
//   const client = new SiweWalletClient({ api, connector: wagmiConnector() });
//   const { user } = await client.login();
//   await client.refresh(); // rotate the refresh cookie before access expiry
// ============================================================================

import type { Address, Chain as ViemChain, Hash } from 'viem';
import type { AxiosInstance } from 'axios';
import { api as defaultApi } from './api';

const CSRF_HEADER = 'X-CSRF-TOKEN';
/** P1-004 explicit transport declaration. Browser = cookie. */
const TRANSPORT_HEADER = 'X-Auth-Transport';
const TRANSPORT_COOKIE = 'cookie';

/** Local mirror of the server's ApiResponse envelope (avoids a shared import). */
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
  /**
   * Access JWT. Present in api / legacy transport responses only. In cookie
   * transport the server sets the access token as an HttpOnly cookie and omits
   * it from the body — the browser session is carried by the cookie, not JS.
   */
  accessToken?: string;
  /**
   * Refresh token. Present in api / legacy transport responses only. In cookie
   * transport the server sets it as an HttpOnly cookie and it is NEVER exposed
   * to JS (so it can never leak into localStorage / logs / a Bearer header).
   */
  refreshToken?: string;
  user: VerifyResponseUser;
}

export interface LoginConnector {
  /** return [{ chain, address }, signMessage] */
  connect(): Promise<{ address: Address; chainId: number }>;
  /** EIP-191 personal_sign via the connected wallet. */
  signMessage(message: string): Promise<`0x${string}`>;
  /** Maps chainId → backend Chain enum + network name. */
  resolveChain(chainId: number): { chain: string; network: string } | null;
}

/** Build a fully-compliant EIP-4361 A-BNF sign-in string. */
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

/** Default chain → backend mapping; extend later for BSC/Polygon/Arbitrum pages. */
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
  /** Cached CSRF token (Double Submit Cookie). Cleared on logout. */
  private csrfToken: string | undefined;

  constructor(
    private readonly connector: LoginConnector,
    private readonly http: AxiosInstance = defaultApi,
    /** In-memory session store; persists for page lifetime only. */
    private readonly session: { token?: string } = {},
  ) {}

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

  /**
   * Ensure a CSRF token is cached. Fetched lazily from GET /auth/csrf-token on
   * the first state-changing request. The server also sets the matching
   * (non-HttpOnly) CSRF cookie, which `withCredentials` carries back.
   */
  private async ensureCsrfToken(): Promise<void> {
    if (this.csrfToken) return;
    const r = await this.http.get<ApiResponseEnvelope<{ csrfToken: string }>>('/auth/csrf-token');
    this.csrfToken = r.data.success ? r.data.data!.csrfToken : undefined;
  }

  /**
   * POST to an auth route. The browser always declares cookie transport so the
   * server sets HttpOnly cookies and never returns token plaintext in the body.
   * CSRF (Double Submit Cookie) is attached for state-changing requests.
   *
   * NOTE: in cookie transport the Bearer header is intentionally NOT sent —
   * the access cookie carries the session. `session.token` is only populated
   * in api/legacy mode; when present it is still attached for backward compat.
   */
  private async post<T>(path: string, body: unknown): Promise<T> {
    // verify is exempt (pre-session) but logout/refresh (cookie mode) require
    // CSRF. Fetching a token for verify too is harmless and keeps the path simple.
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
    // Cookie transport: accessToken is absent from the body (HttpOnly cookie).
    // Keep populating session.token for api/legacy callers; in cookie mode it
    // stays undefined and the access cookie carries the session.
    this.session.token = resp.accessToken;
    return { token: resp.accessToken, user: resp.user };
  }

  /**
   * P1-004: rotate the refresh token (HttpOnly refresh cookie). Sends an empty
   * body — the refresh token is read from the cookie by the server, never from
   * JS. CSRF is enforced (cookie transport). On success the server sets fresh
   * access + refresh cookies.
   *
   * Error handling:
   *   - 409 RETRY: the refresh token was just used (network retry). The access
   *     cookie may still be valid, so the caller can retry once; the refresh
   *     cookie was cleared by the server, so a second retry will 401 INVALID →
   *     the caller should re-authenticate via `login()`.
   *   - 401 INVALID / 403 REUSED / 403 REVOKED: the session is gone — clear and
   *     re-authenticate via SIWE.
   */
  async refresh(): Promise<{ user: VerifyResponseUser }> {
    try {
      const resp = await this.post<VerifyResponse>('/auth/refresh', {});
      return { user: resp.user };
    } catch (err) {
      const status = (err as { response?: { status?: number } }).response?.status;
      if (status === 409) {
        // Retry once — the rotation race resolved as RETRY; a fresh attempt may
        // succeed if the client's refresh cookie is still the active one.
        const resp = await this.post<VerifyResponse>('/auth/refresh', {});
        return { user: resp.user };
      }
      // 401 / 403 — session revoked or invalid. Clear and propagate so the
      // caller can re-run `login()`.
      this.clearSession();
      throw err;
    }
  }
}

// Unused imports (kept for type completeness only).
export type _HashAlias = Hash;
export type _ViemChainAlias = ViemChain;
