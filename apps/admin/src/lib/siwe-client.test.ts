// ============================================================================
// T05 — SiweWalletClient.buildSiweMessage shape compliance
//   (a) includes "Request ID: {requestId}" when provided
//   (b) chainId, nonce, address present
//   (c) statement present when provided
// ============================================================================

import { buildSiweMessage, SiweWalletClient, type LoginConnector } from './siwe-client';

const sampleConnector: LoginConnector = {
  connect: jest.fn().mockResolvedValue({ address: '0xA', chainId: 1 }),
  signMessage: jest.fn().mockResolvedValue('0xsig' as `0x${string}`),
  resolveChain: jest.fn().mockReturnValue({ chain: 'ETH', network: 'mainnet' }),
};

describe('T05 — buildSiweMessage', () => {
  it('T05.1 includes address chainId nonce uri domain basics', () => {
    const msg = buildSiweMessage({
      domain: 'localhost',
      address: '0x0000000000000000000000000000000000000001',
      uri: 'http://localhost:3001',
      chainId: 1,
      nonce: 'N1',
      issuedAtIso: '2026-01-01T00:00:00.000Z',
      expirationTimeIso: '2026-01-01T00:10:00.000Z',
    });
    expect(msg).toContain('0x0000000000000000000000000000000000000001');
    expect(msg).toContain('Chain ID: 1');
    expect(msg).toContain('Nonce: N1');
    expect(msg).toContain('URI: http://localhost:3001');
    expect(msg).toContain('localhost wants you to sign in with your Ethereum account:');
  });

  it('T05.2 Request ID section present when provided', () => {
    const msg = buildSiweMessage({
      domain: 'localhost',
      address: '0x1',
      uri: 'http://localhost:3001',
      chainId: 1,
      nonce: 'N2',
      requestId: 'admin-xyz',
    });
    expect(msg).toContain('Request ID: admin-xyz');
  });

  it('T05.3 statement section present when provided', () => {
    const msg = buildSiweMessage({
      domain: 'localhost',
      address: '0x1',
      uri: 'http://localhost:3001',
      chainId: 1,
      nonce: 'N3',
      statement: 'Accept admin TOS.',
    });
    expect(msg).toContain('Accept admin TOS.');
  });

  it('T05.4 no Resources or Not Before when absent', () => {
    const msg = buildSiweMessage({
      domain: 'localhost',
      address: '0x1',
      uri: 'http://localhost:3001',
      chainId: 1,
      nonce: 'N4',
    });
    expect(msg).not.toContain('Resources:');
    expect(msg).not.toContain('Not Before:');
    expect(msg).not.toContain('Request ID:');
  });
});

describe('SiweWalletClient login — nonce chainId mismatch throws', () => {
  it('throws when backend nonce chainId != wallet chainId', async () => {
    const fakeHttp = {
      get: jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            nonce: 'N',
            issuedAt: '',
            expiresAt: '',
            domain: 'localhost',
            uri: 'http://localhost',
            chainId: 5, // mismatch with connector chainId=1
          },
        },
      }),
      post: jest.fn(),
    };
    const client = new SiweWalletClient(
      {
        connect: jest.fn().mockResolvedValue({ address: '0xA', chainId: 1 }),
        signMessage: jest.fn(),
        resolveChain: jest.fn().mockReturnValue({ chain: 'ETH', network: 'goerli' }),
      },
      fakeHttp as never,
    );
    await expect(client.login()).rejects.toThrow(/chainId/);
  });

  it('login rejects if connector absent', async () => {
    const client = new SiweWalletClient();
    await expect(client.login()).rejects.toThrow(/LoginConnector not set/);
  });

  it('setConnector allows login() without constructor connector', async () => {
    let getCalls = 0;
    const fakeHttp = {
      get: jest.fn().mockImplementation(() => {
        getCalls += 1;
        if (getCalls === 1) {
          // first GET call from login() → /auth/nonce (chainId must match connector)
          return Promise.resolve({
            data: {
              success: true,
              data: {
                nonce: 'N',
                issuedAt: '',
                expiresAt: '',
                domain: 'localhost',
                uri: 'http://localhost',
                chainId: 1,
              },
            },
          });
        }
        // /auth/csrf-token called inside post() via ensureCsrfToken
        return Promise.resolve({
          data: {
            success: true,
            data: { csrfToken: 'CSRF1' },
          },
        });
      }),
      post: jest.fn().mockResolvedValue({
        data: {
          success: true,
          data: {
            accessToken: 'AT',
            user: { id: 'u', status: 'ACTIVE', lastLoginAt: null, wallets: [] },
          },
        },
      }),
    };
    const client = new SiweWalletClient(undefined, fakeHttp as never);
    client.setConnector(sampleConnector);
    const res = await client.login();
    expect(res.token).toBe('AT');
    expect(client.token).toBe('AT');
  });
});
