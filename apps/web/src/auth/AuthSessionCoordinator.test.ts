// ============================================================================
// P1-005 — T15: AuthSessionCoordinator 单元测试
//
// 覆盖 spec v3 状态机：
//   - restore() 全程 initializing，即使内部执行 refresh 也不广播 refreshing (AC-21)
//   - 409 → /auth/me 判定，不循环 refresh (AC-5)
//   - refreshing 仅用于运行时 401 (AC-22)
//   - single-flight 并发 401 (AC-12)
//   - Coordinator 不依赖 React (AC-14)
//   - 强制约束 B：Coordinator 仅用 authApi/SiweWalletClient
// ============================================================================

import { AuthSessionCoordinator, type SessionState } from './AuthSessionCoordinator';
import type { SiweWalletClient, VerifyResponseUser, LoginConnector } from '@/lib/siwe-client';
import type { Address } from 'viem';

// ============================================================================
// Fake SiweWalletClient — 模拟 me()/refresh()/login()/logout() 的各种响应
// ============================================================================

interface FakeResponses {
  me?:
    | { status: number; user?: VerifyResponseUser }
    | (() => Promise<{ status: number; user?: VerifyResponseUser }>);
  refresh?:
    | { status: number; user?: VerifyResponseUser }
    | (() => Promise<{ status: number; user?: VerifyResponseUser }>);
  login?: { status: number; user?: VerifyResponseUser };
  logout?: { status: number };
}

function makeUser(id = 'u-1'): VerifyResponseUser {
  return {
    id,
    status: 'ACTIVE',
    lastLoginAt: null,
    wallets: [
      {
        id: 'w-1',
        address: '0xabc',
        chain: 'ETH',
        network: 'mainnet',
        status: 'ACTIVE',
        isPrimary: true,
      },
    ],
  };
}

/**
 * 构造一个带 response.status 的真实 Error（模拟 axios 的 AxiosError 形状）。
 * 用真实 Error 而非裸对象，使 `rejects.toThrow()` 能识别（jest 的 toThrow 要求
 * 被抛值是 Error 实例）；同时保留 .response.status 供 Coordinator.httpStatus 读取。
 */
function makeError(status: number): Error & { response: { status: number }; status: number } {
  const e = new Error(`HTTP ${status}`) as Error & { response: { status: number }; status: number };
  e.response = { status };
  e.status = status;
  return e;
}

function makeFakeClient(resps: FakeResponses): {
  client: SiweWalletClient;
  calls: { me: number; refresh: number; login: number; logout: number };
} {
  const calls = { me: 0, refresh: 0, login: 0, logout: 0 };
  const client = {
    calls,
    async me(): Promise<VerifyResponseUser> {
      calls.me++;
      const r = resps.me;
      if (!r) throw makeError(401);
      const out = typeof r === 'function' ? await r() : r;
      if (out.status === 200 && out.user) return out.user;
      throw makeError(out.status);
    },
    async refresh(): Promise<{ user: VerifyResponseUser }> {
      calls.refresh++;
      const r = resps.refresh;
      if (!r) throw makeError(401);
      const out = typeof r === 'function' ? await r() : r;
      if (out.status === 200 && out.user) return { user: out.user };
      throw makeError(out.status);
    },
    async login(): Promise<{ user: VerifyResponseUser }> {
      calls.login++;
      const r = resps.login;
      if (r && r.status === 200 && r.user) return { user: r.user };
      throw makeError(r?.status ?? 401);
    },
    async logout(): Promise<{ loggedOut: boolean }> {
      calls.logout++;
      return { loggedOut: true };
    },
    clearSession(): void {},
    setConnector(): void {}, // P1-005 修订：login(connector) 会调 setConnector
    token: undefined,
    // SiweWalletClient 构造签名兼容（测试不实际调用 connector）
  } as unknown as SiweWalletClient;
  return { client, calls };
}

/** 构造一个 fake LoginConnector（仅 login 签名需要；Coordinator.login(connector) 注入）。 */
function makeFakeConnector(): LoginConnector {
  return {
    connect: async () => ({ address: '0xabc' as Address, chainId: 1 }),
    signMessage: async () => '0x' as `0x${string}`,
    resolveChain: () => ({ chain: 'ETH', network: 'mainnet' }),
  };
}

/** 收集 Coordinator 广播的状态序列。 */
function collectStates(co: AuthSessionCoordinator): SessionState[] {
  const states: SessionState[] = [];
  co.subscribe((s) => states.push(s));
  return states;
}

/** 创建新的 Coordinator 实例（避免模块单例污染）。 */
function newCoordinator(): AuthSessionCoordinator {
  return new AuthSessionCoordinator();
}

// ============================================================================
// restore() 测试
// ============================================================================

describe('P1-005 AuthSessionCoordinator.restore()', () => {
  it('R01 /auth/me 200 → authenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({ me: { status: 200, user: makeUser() } });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    // 状态序列：initializing → authenticated（不出现 refreshing）
    expect(states.map((s) => s.status)).toEqual(['initializing', 'authenticated']);
    expect(co.getState().status).toBe('authenticated');
    expect(co.getState().user).not.toBeNull();
  });

  it('R02 /auth/me 401 → refresh 200 → authenticated（全程 initializing，不广播 refreshing）', async () => {
    const co = newCoordinator();
    const { client, calls } = makeFakeClient({
      me: { status: 401 },
      refresh: { status: 200, user: makeUser() },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    // 关键断言（AC-21）：全程只有 initializing 和 authenticated，绝不出现 refreshing
    expect(states.map((s) => s.status)).toEqual(['initializing', 'authenticated']);
    expect(calls.me).toBe(1);
    expect(calls.refresh).toBe(1);
    expect(co.getState().status).toBe('authenticated');
  });

  it('R03 /auth/me 401 → refresh 409 → /auth/me 200 → authenticated', async () => {
    const co = newCoordinator();
    let meCallCount = 0;
    const { client, calls } = makeFakeClient({
      me: () => {
        meCallCount++;
        // 第一次 me 401，409 后第二次 me 200
        return Promise.resolve(
          meCallCount === 1 ? { status: 401 } : { status: 200, user: makeUser() },
        );
      },
      refresh: { status: 409 },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    expect(states.map((s) => s.status)).toEqual(['initializing', 'authenticated']);
    expect(calls.me).toBe(2); // 初始 me + 409 后的 me
    expect(calls.refresh).toBe(1); // 只 refresh 一次，不循环
    expect(co.getState().status).toBe('authenticated');
  });

  it('R04 /auth/me 401 → refresh 409 → /auth/me 401 → unauthenticated', async () => {
    const co = newCoordinator();
    const { client, calls } = makeFakeClient({
      me: { status: 401 }, // 所有 me 调用都 401
      refresh: { status: 409 },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    expect(states.map((s) => s.status)).toEqual(['initializing', 'unauthenticated']);
    expect(calls.refresh).toBe(1); // 不循环
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('R05 /auth/me 401 → refresh 401 → unauthenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      me: { status: 401 },
      refresh: { status: 401 },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    expect(states.map((s) => s.status)).toEqual(['initializing', 'unauthenticated']);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('R06 /auth/me 401 → refresh 403 REUSED → unauthenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      me: { status: 401 },
      refresh: { status: 403 },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    expect(states.map((s) => s.status)).toEqual(['initializing', 'unauthenticated']);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('R07 /auth/me 403 → unauthenticated（非 401，不触发 refresh）', async () => {
    const co = newCoordinator();
    const { client, calls } = makeFakeClient({
      me: { status: 403 },
      refresh: { status: 200, user: makeUser() },
    });
    co.registerClient(client);
    const states = collectStates(co);

    await co.restore();

    expect(states.map((s) => s.status)).toEqual(['initializing', 'unauthenticated']);
    expect(calls.refresh).toBe(0); // 403 不触发 refresh
  });

  it('R08 restore 只执行一次（重复调用无副作用）', async () => {
    const co = newCoordinator();
    const { client, calls } = makeFakeClient({ me: { status: 200, user: makeUser() } });
    co.registerClient(client);

    await co.restore();
    await co.restore(); // 第二次应该 no-op

    expect(calls.me).toBe(1);
  });

  it('R09 无 client 注册 → unauthenticated', async () => {
    const co = newCoordinator();
    const states = collectStates(co);

    await co.restore();

    // subscribe 推送初始 initializing，restore 无 client 直接转 unauthenticated
    expect(states.map((s) => s.status)).toEqual(['initializing', 'unauthenticated']);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('R10 SiweWalletClient connector 可选 + setConnector；login 无 connector 抛错（Fix 1）', async () => {
    // 验证 me/refresh/logout 不依赖 connector，仅 login 需要：
    //   - new SiweWalletClient() 无 connector 不抛
    //   - setConnector 可后续注入
    //   - login 在调 http 前即抛 "LoginConnector not set"（不发请求）
    const { SiweWalletClient } = require('@/lib/siwe-client');
    const client = new SiweWalletClient(); // 无 connector，默认 authApi
    expect(typeof client.setConnector).toBe('function');
    expect(typeof client.me).toBe('function');
    expect(typeof client.refresh).toBe('function');
    expect(typeof client.logout).toBe('function');
    // login 无 connector → 在发请求前抛错（不触发网络）
    await expect(client.login()).rejects.toThrow(/LoginConnector not set/);
  });
});

// ============================================================================
// handleUnauthorized() 测试（运行时 401，已 authenticated）
// ============================================================================

describe('P1-005 AuthSessionCoordinator.handleUnauthorized()（运行时 401）', () => {
  it('U01 refresh 200 → 广播 authenticated + retried=true', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      me: { status: 200, user: makeUser('u-init') },
      refresh: { status: 200, user: makeUser('u-refresh') },
    });
    co.registerClient(client);
    await co.restore();

    const result = await co.handleUnauthorized();
    expect(result.retried).toBe(true);
    expect(co.getState().status).toBe('authenticated');
    expect(co.getState().user?.id).toBe('u-refresh');
  });

  it('U02 refresh 409 → /auth/me 200 → authenticated + retried=true', async () => {
    const co = newCoordinator();
    let meCount = 0;
    const { client, calls } = makeFakeClient({
      me: () => {
        meCount++;
        // restore 的 me 200；409 后的 me 200
        return Promise.resolve({ status: 200, user: makeUser(`u-me-${meCount}`) });
      },
      refresh: { status: 409 },
    });
    co.registerClient(client);
    await co.restore();
    const meAfterRestore = meCount;

    const result = await co.handleUnauthorized();

    expect(result.retried).toBe(true);
    expect(calls.me).toBe(meAfterRestore + 1); // 409 后调用了一次 /me
    expect(calls.refresh).toBe(1); // 不循环
    expect(co.getState().status).toBe('authenticated');
  });

  it('U03 refresh 409 → /auth/me 401 → unauthenticated + retried=false', async () => {
    const co = newCoordinator();
    let meCount = 0;
    const { client } = makeFakeClient({
      me: () => {
        meCount++;
        // restore 的 /me（第1次）→ 200 进入 authenticated；
        // handleUnauthorized 409 后的 /me（第2次）→ 401 视为会话失效
        return Promise.resolve(meCount === 1 ? { status: 200, user: makeUser() } : { status: 401 });
      },
      refresh: { status: 409 },
    });
    co.registerClient(client);
    await co.restore(); // meCount=1 → 200 → authenticated

    const result = await co.handleUnauthorized(); // refresh 409 → me meCount=2 → 401

    expect(result.retried).toBe(false);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('U04 refresh 401 → unauthenticated + retried=false', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      me: { status: 200, user: makeUser() },
      refresh: { status: 401 },
    });
    co.registerClient(client);
    await co.restore();

    const result = await co.handleUnauthorized();

    expect(result.retried).toBe(false);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('U05 refresh 403 REUSED → unauthenticated + retried=false', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      me: { status: 200, user: makeUser() },
      refresh: { status: 403 },
    });
    co.registerClient(client);
    await co.restore();

    const result = await co.handleUnauthorized();

    expect(result.retried).toBe(false);
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('U06 single-flight：并发 401 只 refresh 一次', async () => {
    const co = newCoordinator();
    let refreshCount = 0;
    const { client } = makeFakeClient({
      me: { status: 200, user: makeUser() },
      refresh: () => {
        refreshCount++;
        // 模拟延迟，让并发请求有机会合并
        return new Promise((r) => setTimeout(() => r({ status: 200, user: makeUser() }), 50));
      },
    });
    co.registerClient(client);
    await co.restore();

    // 并发 3 个 handleUnauthorized
    const [r1, r2, r3] = await Promise.all([
      co.handleUnauthorized(),
      co.handleUnauthorized(),
      co.handleUnauthorized(),
    ]);

    expect(refreshCount).toBe(1); // single-flight
    expect(r1.retried).toBe(true);
    expect(r2.retried).toBe(true);
    expect(r3.retried).toBe(true);
  });

  it('U07 409 后不再 refresh（禁止循环 refresh）', async () => {
    const co = newCoordinator();
    const { client, calls } = makeFakeClient({
      me: { status: 401 }, // 409 后的 me 也 401
      refresh: { status: 409 },
    });
    co.registerClient(client);
    await co.restore();

    // 再触发一次 handleUnauthorized（应该再 refresh 一次，因为前一次的 inflight 已结束）
    // 但每次 handleUnauthorized 内 409 后只调 /me 不再 refresh
    calls.refresh = 0;
    calls.me = 0;
    await co.handleUnauthorized();

    expect(calls.refresh).toBe(1); // 这一次 handleUnauthorized 触发的
    expect(calls.me).toBe(1); // 409 后的 /me
  });
});

// ============================================================================
// handleForbidden() 测试
// ============================================================================

describe('P1-005 AuthSessionCoordinator.handleForbidden()', () => {
  it('F01 403 → unauthenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({ me: { status: 200, user: makeUser() } });
    co.registerClient(client);
    await co.restore();
    expect(co.getState().status).toBe('authenticated');

    co.handleForbidden();

    expect(co.getState().status).toBe('unauthenticated');
  });
});

// ============================================================================
// login() / logout() 测试
// ============================================================================

describe('P1-005 AuthSessionCoordinator.login()/logout()', () => {
  it('L01 login(connector) 200 → authenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      login: { status: 200, user: makeUser('u-login') },
      me: { status: 401 }, // restore 失败
    });
    co.registerClient(client);
    await co.restore();
    expect(co.getState().status).toBe('unauthenticated');

    const user = await co.login(makeFakeConnector());
    expect(user.id).toBe('u-login');
    expect(co.getState().status).toBe('authenticated');
  });

  it('L02 login 失败 → 抛错（不改状态）', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({
      login: { status: 401 },
      me: { status: 401 },
    });
    co.registerClient(client);
    await co.restore();

    await expect(co.login(makeFakeConnector())).rejects.toThrow();
    expect(co.getState().status).toBe('unauthenticated');
  });

  it('L03 logout → unauthenticated', async () => {
    const co = newCoordinator();
    const { client } = makeFakeClient({ me: { status: 200, user: makeUser() } });
    co.registerClient(client);
    await co.restore();
    expect(co.getState().status).toBe('authenticated');

    await co.logout();
    expect(co.getState().status).toBe('unauthenticated');
  });
});

// ============================================================================
// 框架无关性 + 强制约束 B 验证
// ============================================================================

describe('P1-005 AuthSessionCoordinator 架构约束', () => {
  it('C01 Coordinator 不依赖 React（纯 TS class，可独立实例化）', () => {
    const co = new AuthSessionCoordinator();
    expect(co).toBeInstanceOf(AuthSessionCoordinator);
    expect(co.getState().status).toBe('initializing');
    expect(typeof co.subscribe).toBe('function');
    expect(typeof co.restore).toBe('function');
    expect(typeof co.handleUnauthorized).toBe('function');
    expect(typeof co.handleForbidden).toBe('function');
  });

  it('C02 subscribe 返回取消订阅函数', () => {
    const co = newCoordinator();
    const calls: SessionState[] = [];
    const unsub = co.subscribe((s) => calls.push(s));
    expect(typeof unsub).toBe('function');
    unsub();
    // 取消后再广播不应触发
    co.handleForbidden();
    expect(calls.length).toBe(1); // 只有初始 subscribe 时的推送
  });
});
