// ============================================================================
// P1-005 — AuthSessionCoordinator
//
// 单例（框架无关，不依赖 React）。职责：
//   1. restore()：应用启动调 /auth/me 恢复会话（全程 initializing，不广播 refreshing）
//   2. handleUnauthorized(originalRequest)：运行时 401 → single-flight refresh + 重试
//      - 开始 refresh 时广播 'refreshing'（保留上一个 authenticated 的 user，供 ProtectedRoute 继续渲染 children）
//      - refresh 200 → authenticated + 重试原请求
//      - refresh 409 → 禁止循环 refresh；调 /auth/me：200 则 authenticated + 重试；
//        401/403 则 unauthenticated → /login
//      - refresh 401/403 → unauthenticated → /login
//   3. handleUnauthorizedRestore()：初始化期 401 → 单次 refresh（不广播 refreshing）
//   4. handleForbidden()：403 REUSED/REVOKED → 清状态 → /login
//
// P1-005 修订（session restore + refreshing 真实广播）：
//   - 模块导出的单例 authCoordinator 在创建后立即注册一个默认 SiweWalletClient（无 connector）。
//     这样应用启动（AuthProvider mount）即可调用 me/refresh/logout 恢复会话，
//     不再依赖用户先连接钱包。钱包 connector 仅 login() 签名时需要，由 login(connector) 注入。
//   - registerClient 仍保留：测试可注入 fake client；生产也可覆盖（一般不需要）。
//   - refreshing 状态由 Coordinator 真实广播（spec v3 状态机规则 10-12）：
//     authenticated 运行时 401 → refreshing（保留 user）→ authenticated/unauthenticated。
//     初始化 restore 期间永远不广播 refreshing（spec v3 AC-21 / 规则 6）。
//
// 依赖（强制约束 B）：
//   - 仅使用 SiweWalletClient（其内部用 authApi，无 401 拦截器）
//   - 禁止使用业务 api.ts（会形成循环依赖）
//
// 状态机（spec v3）：
//   sessionState ∈ 'initializing' | 'authenticated' | 'refreshing' | 'unauthenticated'
//   'authenticating' 是 AuthProvider 派生的 UI 状态（login 进行中）。
//   'refreshing' 由 Coordinator 在 handleUnauthorized 开始 refresh 时真实广播。
// ============================================================================

import type { AxiosRequestConfig } from 'axios';
import { SiweWalletClient, type VerifyResponseUser, type LoginConnector } from '@/lib/siwe-client';

/**
 * Coordinator 广播的会话状态。AuthProvider 订阅并派生 UI 状态。
 *
 * 'refreshing' 保留上一个 authenticated 的 user，使 ProtectedRoute 能继续渲染 children
 * （spec v3 规则 11：refreshing → 渲染 children，保持当前视图）。
 */
export type SessionState =
  | { status: 'initializing'; user: null }
  | { status: 'authenticated'; user: VerifyResponseUser }
  | { status: 'refreshing'; user: VerifyResponseUser }
  | { status: 'unauthenticated'; user: null };

/** 订阅回调。 */
export type SessionListener = (state: SessionState) => void;

/** refresh 的可能结果（用于 handleUnauthorized 的内部判定）。 */
type RefreshOutcome =
  | { kind: 'success'; user: VerifyResponseUser }
  | { kind: 'retry' } // 409 RETRY → 需要 /auth/me 判定
  | { kind: 'invalid' } // 401 INVALID
  | { kind: 'forbidden' } // 403 REUSED/REVOKED
  | { kind: 'network-error' };

/** 从 axios 错误里取 HTTP status。 */
function httpStatus(err: unknown): number | undefined {
  const e = err as { response?: { status?: number }; status?: number };
  return e?.response?.status ?? e?.status;
}

/**
 * AuthSessionCoordinator 单例。
 *
 * 框架无关：不 import React，不依赖 React Context。AuthProvider 在 mount 时
 * subscribe 它，业务 api.ts 的 401 拦截器调用它的 handleUnauthorized。
 */
export class AuthSessionCoordinator {
  private client: SiweWalletClient | null = null;
  private listeners = new Set<SessionListener>();
  private state: SessionState = { status: 'initializing', user: null };

  /** single-flight：同一时刻最多一个 refresh 在途。 */
  private inflightRefresh: Promise<RefreshOutcome> | null = null;

  /** restore() 只允许执行一次（AuthProvider mount 时）。 */
  private restoreStarted = false;

  /** 注册 SiweWalletClient（由 AuthProvider 在 mount 时注入）。 */
  registerClient(client: SiweWalletClient): void {
    this.client = client;
  }

  /** 订阅状态变化。返回取消订阅函数。 */
  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    // 立即推送当前状态给新订阅者。
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 当前状态（同步读取，供非 React 代码或测试使用）。 */
  getState(): SessionState {
    return this.state;
  }

  /** 广播状态。 */
  private notify(state: SessionState): void {
    this.state = state;
    for (const l of this.listeners) l(state);
  }

  // ==========================================================================
  // restore() — 应用启动恢复会话（T05）
  // ==========================================================================

  /**
   * 应用启动时调用一次（AuthProvider mount）。
   * 全程保持 initializing，即使内部执行 refresh 也不广播 refreshing（spec v3 AC-21）。
   */
  async restore(): Promise<void> {
    if (this.restoreStarted) return; // 只允许一次
    this.restoreStarted = true;
    if (!this.client) {
      // 没有 client（未注入 connector），无法恢复 → unauthenticated
      this.notify({ status: 'unauthenticated', user: null });
      return;
    }
    // 状态已是 initializing（构造函数默认值，subscribe 时已广播给订阅者）。
    // 全程保持 initializing，即使内部执行 refresh 也不广播 refreshing（spec v3 AC-21）。
    try {
      const user = await this.client.me();
      this.notify({ status: 'authenticated', user });
    } catch (err) {
      const status = httpStatus(err);
      if (status === 401) {
        // 初始化期 401 → 单次 refresh（不广播 refreshing）
        await this.handleUnauthorizedRestore();
      } else {
        // 403 / 网络错误 / 其他 → 未登录
        this.notify({ status: 'unauthenticated', user: null });
      }
    }
  }

  /**
   * 初始化期 401 的恢复分支：单次 refresh，全程保持 initializing（不广播 refreshing）。
   * - refresh 200 → authenticated
   * - refresh 409 → /auth/me 判定（见 resolveRetry）
   * - refresh 401/403 → unauthenticated
   */
  private async handleUnauthorizedRestore(): Promise<void> {
    const outcome = await this.runRefreshOnce();
    if (outcome.kind === 'success') {
      this.notify({ status: 'authenticated', user: outcome.user });
      return;
    }
    if (outcome.kind === 'retry') {
      // 409 → /auth/me 判定（不循环 refresh）
      const resolved = await this.resolveRetryViaMe();
      if (resolved) {
        // authenticated 已在 resolveRetryViaMe 内 notify
        return;
      }
      this.notify({ status: 'unauthenticated', user: null });
      return;
    }
    // invalid / forbidden / network-error
    this.notify({ status: 'unauthenticated', user: null });
  }

  // ==========================================================================
  // handleUnauthorized() — 运行时 401（已 authenticated 后）（T06）
  // ==========================================================================

  /**
   * 业务请求（via api.ts）返回 401 时调用。
   * - 若当前状态为 authenticated：广播 refreshing（保留 user，ProtectedRoute 继续渲染 children）
   *   然后开始 single-flight refresh。spec v3 规则 10-12。
   * - single-flight refresh
   * - 200 → authenticated + 重试原请求
   * - 409 → /auth/me 判定 + 重试原请求（最多1次）
   * - 401/403 → unauthenticated → /login
   *
   * ⚠️ refreshing 只在已 authenticated 时广播；初始化 restore 期间走 handleUnauthorizedRestore，
   *    全程保持 initializing（spec v3 AC-21 / 规则 6），永远不出现 refreshing。
   *
   * 返回值：如果 refresh 后重试原请求成功，返回 { retried: true }；
   * 如果会话失效无法重试，返回 { retried: false }。
   */
  async handleUnauthorized(originalRequest?: AxiosRequestConfig): Promise<{ retried: boolean }> {
    if (!this.client) return { retried: false };

    // 仅当当前是 authenticated 时才广播 refreshing（spec v3 规则 10）。
    // restore 期间不会走到这里（restore 走 handleUnauthorizedRestore）；防御性检查避免误广播。
    const prevState = this.state;
    if (prevState.status === 'authenticated' && prevState.user) {
      this.notify({ status: 'refreshing', user: prevState.user });
    }

    // single-flight：并发 401 复用同一个 refresh Promise
    const outcome = await this.runRefreshOnce();

    if (outcome.kind === 'success') {
      this.notify({ status: 'authenticated', user: outcome.user });
      // 重试原请求（由 api.ts 拦截器实际发起；这里仅返回信号）
      return { retried: true };
    }

    if (outcome.kind === 'retry') {
      // 409 → /auth/me 判定
      const ok = await this.resolveRetryViaMe();
      if (ok) {
        // authenticated + 重试原请求（最多1次）
        return { retried: true };
      }
      this.notify({ status: 'unauthenticated', user: null });
      return { retried: false };
    }

    // invalid / forbidden / network-error
    this.notify({ status: 'unauthenticated', user: null });
    return { retried: false };
  }

  // ==========================================================================
  // handleForbidden() — 403 REUSED/REVOKED（T08）
  // ==========================================================================

  /**
   * 收到 403 REUSED/REVOKED：清客户端状态 + 广播 unauthenticated。
   * 由 api.ts 拦截器或 refresh 流程调用。
   */
  handleForbidden(): void {
    this.client?.clearSession();
    this.notify({ status: 'unauthenticated', user: null });
  }

  // ==========================================================================
  // 内部：single-flight refresh（T06/T07）
  // ==========================================================================

  /**
   * 执行一次 refresh（single-flight）。并发调用复用同一 Promise。
   * 不 clearSession，不广播状态——由调用方根据 outcome 决定。
   */
  private runRefreshOnce(): Promise<RefreshOutcome> {
    if (this.inflightRefresh) return this.inflightRefresh;
    this.inflightRefresh = this.doRefresh().finally(() => {
      this.inflightRefresh = null;
    });
    return this.inflightRefresh;
  }

  /** 实际 refresh 调用。 */
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

  /**
   * 409 RETRY → /auth/me 判定（T07）。
   * - /me 200 → authenticated（notify）+ return true
   * - /me 401/403/其他 → return false（调用方转 unauthenticated）
   *
   * 禁止：refresh 循环（不再次调 refresh）。
   */
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

  // ==========================================================================
  // 主动操作（由 AuthProvider 调用）
  // ==========================================================================

  /**
   * 用户发起 SIWE 登录。调用方（AuthProvider）负责设置 'authenticating' UI 状态。
   * connector 由登录页注入（仅 login 签名需要）；me/refresh/logout 不依赖它。
   * 成功 → notify authenticated；失败 → notify unauthenticated。
   */
  async login(connector: LoginConnector, requestId?: string): Promise<VerifyResponseUser> {
    if (!this.client) throw new Error('SiweWalletClient not registered');
    this.client.setConnector(connector);
    const { user } = await this.client.login(requestId);
    this.notify({ status: 'authenticated', user });
    return user;
  }

  /** 用户发起 logout。 */
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

  /**
   * 仅测试用：重置单例状态（restoreStarted / inflight / 状态回 initializing），
   * 使连续的 React 集成测试互不影响。生产代码不调用。
   * 注意：不重置已注册的 client（测试通过 registerClient 注入 fake）。
   */
  reset(): void {
    this.restoreStarted = false;
    this.inflightRefresh = null;
    this.notify({ status: 'initializing', user: null });
  }
}

/**
 * 模块级单例。整个应用共享同一个 Coordinator。
 * axios 拦截器（api.ts）和 AuthProvider 都引用这个实例。
 *
 * P1-005 修订：创建后立即注册默认 SiweWalletClient（无 connector），使应用启动即可
 * 调用 me/refresh/logout 恢复会话——不再依赖用户先连接钱包。
 */
export const authCoordinator = new AuthSessionCoordinator();
authCoordinator.registerClient(new SiweWalletClient());
