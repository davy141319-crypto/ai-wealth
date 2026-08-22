// ============================================================================
// P1-007 Admin — AuthSessionCoordinator
//
// 单例（框架无关，不依赖 React）。职责：
//   1. restore()：应用启动调 /auth/me 恢复会话（全程 initializing，不广播 refreshing）
//   2. handleUnauthorized(originalRequest)：运行时 401 → single-flight refresh + 重试
//   3. handleUnauthorizedRestore()：初始化期 401 → 单次 refresh（不广播 refreshing）
//   4. handleForbidden()：403 REUSED/REVOKED → 清状态 → /login
//
// 依赖（强制约束 B）：
//   - 仅使用 SiweWalletClient（其内部用 authApi，无 401 拦截器）
//   - 禁止使用业务 api.ts（会形成循环依赖）
//
// 状态机：
//   sessionState ∈ 'initializing' | 'authenticated' | 'refreshing' | 'unauthenticated'
// ============================================================================

import type { AxiosRequestConfig } from 'axios';
import { SiweWalletClient, type VerifyResponseUser, type LoginConnector } from '@/lib/siwe-client';

export type SessionState =
  | { status: 'initializing'; user: null }
  | { status: 'authenticated'; user: VerifyResponseUser }
  | { status: 'refreshing'; user: VerifyResponseUser }
  | { status: 'unauthenticated'; user: null };

export type SessionListener = (state: SessionState) => void;

type RefreshOutcome =
  | { kind: 'success'; user: VerifyResponseUser }
  | { kind: 'retry' }
  | { kind: 'invalid' }
  | { kind: 'forbidden' }
  | { kind: 'network-error' };

function httpStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number };
  return e?.response?.status ?? e?.status;
}

export class AuthSessionCoordinator {
  private client: SiweWalletClient | null = null;
  private listeners = new Set<SessionListener>();
  private state: SessionState = { status: 'initializing', user: null };
  private inflightRefresh: Promise<RefreshOutcome> | null = null;
  private restoreStarted = false;

  registerClient(client: SiweWalletClient): void {
    this.client = client;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): SessionState {
    return this.state;
  }

  private notify(state: SessionState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  async restore(): Promise<void> {
    if (this.restoreStarted) return;
    this.restoreStarted = true;
    if (!this.client) {
      this.notify({ status: 'unauthenticated', user: null });
      return;
    }
    try {
      const user = await this.client.me();
      this.notify({ status: 'authenticated', user });
    } catch (err) {
      const status = httpStatus(err);
      if (status === 401) {
        await this.handleUnauthorizedRestore();
      } else {
        this.notify({ status: 'unauthenticated', user: null });
      }
    }
  }

  private async handleUnauthorizedRestore(): Promise<void> {
    const outcome = await this.runRefreshOnce();
    if (outcome.kind === 'success') {
      this.notify({ status: 'authenticated', user: outcome.user });
      return;
    }
    if (outcome.kind === 'retry') {
      const resolved = await this.resolveRetryViaMe();
      if (resolved) return;
      this.notify({ status: 'unauthenticated', user: null });
      return;
    }
    this.notify({ status: 'unauthenticated', user: null });
  }

  async handleUnauthorized(_originalRequest?: AxiosRequestConfig): Promise<{ retried: boolean }> {
    if (!this.client) return { retried: false };

    const prevState = this.state;
    if (prevState.status === 'authenticated' && prevState.user) {
      this.notify({ status: 'refreshing', user: prevState.user });
    }

    const outcome = await this.runRefreshOnce();

    if (outcome.kind === 'success') {
      this.notify({ status: 'authenticated', user: outcome.user });
      return { retried: true };
    }

    if (outcome.kind === 'retry') {
      const ok = await this.resolveRetryViaMe();
      if (ok) return { retried: true };
      this.notify({ status: 'unauthenticated', user: null });
      return { retried: false };
    }

    this.notify({ status: 'unauthenticated', user: null });
    return { retried: false };
  }

  handleForbidden(): void {
    this.client?.clearSession();
    this.notify({ status: 'unauthenticated', user: null });
  }

  private runRefreshOnce(): Promise<RefreshOutcome> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  private async doRefresh(): Promise<RefreshOutcome> {
    if (!this.client) return { kind: 'invalid' };
    try {
      const { user } = await this.client.refresh();
      return { kind: 'success', user };
    } catch (err) {
      const status = httpStatus(err);
      if (status === 409) return { kind: 'retry' };
      if (status === 403) return { kind: 'forbidden' };
      if (status === 401) return { kind: 'invalid' };
      return { kind: 'network-error' };
    }
  }

  private async resolveRetryViaMe(): Promise<boolean> {
    if (!this.client) return false;
    try {
      const user = await this.client.me();
      this.notify({ status: 'authenticated', user });
      return true;
    } catch {
      return false;
    }
  }

  async login(connector: LoginConnector, requestId?: string): Promise<VerifyResponseUser> {
    if (!this.client) throw new Error('SiweWalletClient not registered');
    this.client.setConnector(connector);
    const { user } = await this.client.login(requestId);
    this.notify({ status: 'authenticated', user });
    return user;
  }

  async logout(): Promise<void> {
    if (!this.client) {
      this.notify({ status: 'unauthenticated', user: null });
      return;
    }
    try {
      await this.client.logout();
    } finally {
      this.notify({ status: 'unauthenticated', user: null });
    }
  }

  reset(): void {
    this.restoreStarted = false;
    this.inflightRefresh = null;
    this.notify({ status: 'initializing', user: null });
  }
}

export const authCoordinator = new AuthSessionCoordinator();
authCoordinator.registerClient(new SiweWalletClient());
