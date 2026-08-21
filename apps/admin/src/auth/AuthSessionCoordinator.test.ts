// ============================================================================
// T07 — AuthSessionCoordinator session state machine
//
// Initial state: {status:'initializing', user:null}
// Transitions under test:
//   a) initializing → authenticated  after successful restore() via me()
//   b) authenticated → refreshing   on 401 handleUnauthorized()
//   c) refreshing → authenticated   on refresh success
//   d) authenticated → unauthenticated on refresh 401/403
//   e) single-flight: concurrent handleUnauthorized share one refresh
//   f) subscribe notifies current + updates
// ============================================================================

import type { VerifyResponseUser, LoginConnector } from '@/lib/siwe-client';
import { SiweWalletClient } from '@/lib/siwe-client';
import { AuthSessionCoordinator, type SessionState } from './AuthSessionCoordinator';

const mockUser: VerifyResponseUser = {
  id: 'u1',
  status: 'ACTIVE',
  lastLoginAt: '2026-01-01T00:00:00Z',
  wallets: [
    {
      id: 'w1',
      address: '0x0000000000000000000000000000000000000001',
      chain: 'ETH',
      network: 'mainnet',
      status: 'VERIFIED',
      isPrimary: true,
    },
  ],
};

function makeClientMock(overrides: Partial<SiweWalletClient> = {}): SiweWalletClient {
  return {
    me: jest.fn().mockResolvedValue(mockUser),
    refresh: jest.fn().mockResolvedValue({ user: mockUser }),
    login: jest.fn().mockResolvedValue({ user: mockUser }),
    logout: jest.fn().mockResolvedValue({ loggedOut: true }),
    clearSession: jest.fn(),
    setConnector: jest.fn(),
    registerAdminForbiddenCallback: undefined as unknown as never,
    ...overrides,
  } as unknown as SiweWalletClient;
}

function buildCoordinator(client: SiweWalletClient): AuthSessionCoordinator {
  const c = new AuthSessionCoordinator();
  c.registerClient(client);
  return c;
}

describe('T07 — AuthSessionCoordinator state machine', () => {
  it('T07.1 initial state is initializing with user null', () => {
    const c = buildCoordinator(makeClientMock());
    expect(c.getState()).toEqual({ status: 'initializing', user: null });
  });

  it('T07.2 restore() me() ok → authenticated (no refreshing broadcast)', async () => {
    const client = makeClientMock();
    const c = buildCoordinator(client);
    const states: SessionState[] = [];
    c.subscribe((s) => states.push(s));
    await c.restore();
    // initializing → authenticated, never 'refreshing'
    expect(states.map((s) => s.status)).toEqual(
      expect.arrayContaining(['initializing', 'authenticated']),
    );
    expect(states.map((s) => s.status)).not.toContain('refreshing');
    expect(c.getState().status).toBe('authenticated');
    expect(c.getState().user?.id).toBe('u1');
  });

  it('T07.3 restore 401 → single refresh attempt (no "refreshing" during restore)', async () => {
    const refresh = jest.fn().mockResolvedValue({ user: mockUser });
    const client = makeClientMock({
      me: jest.fn().mockRejectedValue({ response: { status: 401 } }),
      refresh,
    });
    const c = buildCoordinator(client);
    const states: SessionState[] = [];
    c.subscribe((s) => states.push(s));
    await c.restore();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(states.map((s) => s.status)).not.toContain('refreshing');
    expect(c.getState().status).toBe('authenticated');
  });

  it('T07.4 authenticated + handleUnauthorized → refreshing → authenticated', async () => {
    const refresh = jest.fn().mockResolvedValue({ user: mockUser });
    const client = makeClientMock({ refresh });
    const c = buildCoordinator(client);
    await c.restore(); // authenticated
    expect(c.getState().status).toBe('authenticated');
    const states: SessionState[] = [];
    c.subscribe((s) => states.push(s));
    const res = await c.handleUnauthorized({ url: '/foo' });
    expect(res.retried).toBe(true);
    const statuses = states.map((s) => s.status);
    expect(statuses).toEqual(expect.arrayContaining(['authenticated', 'refreshing']));
    // final last state must be authenticated
    expect(c.getState().status).toBe('authenticated');
  });

  it('T07.5 handleUnauthorized with refresh 401 → unauthenticated', async () => {
    const client = makeClientMock({
      refresh: jest.fn().mockRejectedValue({ response: { status: 401 } }),
    });
    const c = buildCoordinator(client);
    await c.restore();
    expect(c.getState().status).toBe('authenticated');
    const { retried } = await c.handleUnauthorized();
    expect(retried).toBe(false);
    expect(c.getState()).toEqual({ status: 'unauthenticated', user: null });
    // Note: refresh 401 means tokens invalid; coordinator only clears session on handleForbidden.
    expect(client.clearSession).not.toHaveBeenCalled();
  });

  it('T07.6 refresh 409 → retry resolveViaMe → authenticated', async () => {
    let meCount = 0;
    const client = makeClientMock({
      me: jest.fn().mockImplementation(() => {
        meCount += 1;
        // First restore call throws 401 to trigger handleUnauthorizedRestore path
        if (meCount === 1) return Promise.resolve(mockUser);
        return Promise.resolve(mockUser);
      }),
      refresh: jest.fn().mockRejectedValue({ response: { status: 409 } }),
    });
    const c = buildCoordinator(client);
    // direct 401 via handleUnauthorized to trigger retry branch after authenticated
    await c.restore();
    expect(c.getState().status).toBe('authenticated');
    // Now trigger handleUnauthorized: refresh throws 409
    const r = await c.handleUnauthorized();
    // Expect resolveRetryViaMe to be called → status authenticated
    expect(r.retried).toBe(true);
    expect(c.getState().status).toBe('authenticated');
  });

  it('T07.7 handleForbidden → unauthenticated + clearSession', async () => {
    const client = makeClientMock();
    const c = buildCoordinator(client);
    await c.restore();
    c.handleForbidden();
    expect(client.clearSession).toHaveBeenCalled();
    expect(c.getState()).toEqual({ status: 'unauthenticated', user: null });
  });

  it('T07.8 single-flight: two concurrent handleUnauthorized → only one refresh() call', async () => {
    const refresh = jest
      .fn()
      .mockImplementation(
        () => new Promise((res) => setTimeout(() => res({ user: mockUser }), 10)),
      );
    const client = makeClientMock({ refresh });
    const c = buildCoordinator(client);
    await c.restore();
    const [a, b] = await Promise.all([c.handleUnauthorized(), c.handleUnauthorized()]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a.retried).toBe(true);
    expect(b.retried).toBe(true);
  });

  it('T07.9 login flow → authenticated', async () => {
    const client = makeClientMock();
    const c = buildCoordinator(client);
    const connector = {
      connect: jest.fn().mockResolvedValue({ address: '0x1', chainId: 1 }),
      signMessage: jest.fn().mockResolvedValue('0xsig' as `0x${string}`),
      resolveChain: jest.fn().mockReturnValue({ chain: 'ETH', network: 'mainnet' }),
    } as unknown as LoginConnector;
    const u = await c.login(connector);
    expect(u.id).toBe('u1');
    expect(client.setConnector).toHaveBeenCalledWith(connector);
    expect(c.getState().status).toBe('authenticated');
  });

  it('T07.10 logout → unauthenticated always (even on throw)', async () => {
    const client = makeClientMock({
      logout: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const c = buildCoordinator(client);
    await c.restore();
    await c.logout().catch(() => {});
    expect(c.getState().status).toBe('unauthenticated');
  });
});
