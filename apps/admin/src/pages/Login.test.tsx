// ============================================================================
// T03 — Login Page RTL Tests
//
// T03.1 /login renders: SIWE Connect + Sign button + "AI Wealth Admin" title
// T03.2 Login button flow: after wagmi connect + sign → login() called
//          then navigate(next).  Also verifies ?next=/dashboard navigates to /dashboard.
// T03.3 Login failure: error Alert shown "Login failed"; close clears
// T03.4 ?next= safety: tampered next javascript:alert → safe /dashboard
// T03.5 ?next=//evil.com → safe /dashboard
// ============================================================================

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { Login } from './Login';

// ---------- mock wagmi at module level ----------
// NOTE: Do NOT jest.requireActual('wagmi') — wagmi v2 is pure ESM only and cannot
// be parsed by Jest's CJS loader.  Provide stubs for every wagmi import Login.tsx uses.
// IMPORTANT: do NOT expose mock hooks as jest.fn() directly — React 18 treats the
// function reference returned by a hook (which internally uses useSyncExternalStore
// subscription cleanup) as a destroy function; wrapping with { current: jest.fn() }
// avoids "destroy is not a function" errors during RTL cleanup.
jest.mock('wagmi', () => {
  const stubs = {
    account: { address: undefined, chainId: undefined, isConnected: false },
    sign: {
      signMessageAsync: jest.fn().mockResolvedValue('0x0' as `0x${string}`),
    },
    connect: {
      connectAsync: jest.fn().mockResolvedValue({ accounts: ['0x0'], chainId: 1 }),
      connectors: [],
      isPending: false,
    },
  };
  return {
    useAccount: () => stubs.account,
    useSignMessage: () => stubs.sign,
    useConnect: () => stubs.connect,
    __wagmiStubs: stubs,
  };
});
jest.mock('@/auth/AuthProvider', () => {
  const original = jest.requireActual('@/auth/AuthProvider');
  const mockUseAuth = jest.fn();
  return {
    ...original,
    useAuth: mockUseAuth,
    AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});
import { useAuth } from '@/auth/AuthProvider';
// Helper to reach the mutable mock stubs from any test.
function wagmiStubs(): any {
  const mod = jest.requireMock('wagmi') as any;
  return mod.__wagmiStubs;
}

// ---------- capture location changes ----------
// NOTE: We intentionally avoid useLocation effect with unstable onChange callback;
// that pattern creates a new closure on every render and causes React 18 passive
// effect destroy bugs with some dependencies ("destroy is not a function" on cleanup).
// Instead, we use a stable ref-based capture.
function useLocCapture(locsRef: { current: string[] }) {
  const loc = useLocation();
  const ref = React.useRef<typeof loc | null>(null);
  if (ref.current?.pathname !== loc.pathname || ref.current?.search !== loc.search) {
    ref.current = loc;
    locsRef.current.push(loc.pathname + loc.search);
  }
}

function renderLogin(initialEntry = '/login') {
  const locs: string[] = [];
  const locsRef: { current: string[] } = { current: locs };
  function LocCap() {
    useLocCapture(locsRef);
    return null;
  }
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<div data-testid="dashboard" />} />
        <Route path="*" element={<div data-testid="other" />} />
      </Routes>
      <LocCap />
    </MemoryRouter>,
  );
  return { locs };
}

describe('T03 — Login Page RTL', () => {
  const mockLogin = jest
    .fn()
    .mockResolvedValue({ id: 'u', status: 'ACTIVE', lastLoginAt: null, wallets: [] });

  beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: mockLogin,
      logout: jest.fn().mockResolvedValue(undefined),
    });
    const s = wagmiStubs();
    s.account = { address: undefined, chainId: undefined, isConnected: false };
    s.sign = {
      signMessageAsync: jest.fn().mockResolvedValue('0xabc' as `0x${string}`),
    };
    s.connect = {
      connectAsync: jest.fn().mockResolvedValue({
        accounts: ['0xA'],
        chainId: 1,
      }),
      connectors: [{ id: 'mock' }],
      isPending: false,
    };
  });

  it('T03.1 renders AI Wealth Admin title + SIWE sign button + wallet auth alert', () => {
    renderLogin();
    expect(screen.getByText('AI Wealth Admin')).toBeInTheDocument();
    expect(screen.getByText(/Wallet Authentication/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Connect Wallet & Sign In/i })).toBeInTheDocument();
    expect(
      screen.getByText(/HttpOnly cookies; no tokens are stored in localStorage/),
    ).toBeInTheDocument();
  });

  it('T03.2 login calls login() + navigates to /dashboard', async () => {
    const user = userEvent.setup();
    const { locs } = renderLogin('/login?next=%2Fdashboard');
    const btn = screen.getByRole('button', { name: /Connect Wallet & Sign In/i });
    await user.click(btn);
    await waitFor(() => expect(mockLogin).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(locs).toContain('/dashboard'));
  });

  it('T03.3 login failure: Alert shows "Login failed"; closeable clears error', async () => {
    const errMsg = 'User rejected signature';
    const us = userEvent.setup();
    (useAuth as jest.Mock).mockReturnValue({
      status: 'unauthenticated',
      user: null,
      login: jest.fn().mockRejectedValue(new Error(errMsg)),
      logout: jest.fn().mockResolvedValue(undefined),
    });
    renderLogin('/login');
    const btn = screen.getByRole('button', { name: /Connect Wallet & Sign In/i });
    await us.click(btn);
    await waitFor(() => {
      expect(screen.getByText('Login failed')).toBeInTheDocument();
      expect(screen.getByText(errMsg)).toBeInTheDocument();
    });
    // Antd Alert with closable renders a close button.
    // Use the first button containing "Close" (aria-label may vary by antd version).
    const closeBtn = (() => {
      const buttons = screen.queryAllByRole('button', { hidden: true });
      for (const b of buttons) {
        const label = b.getAttribute('aria-label') || '';
        if (/close/i.test(label) || /close/i.test(b.textContent || '')) return b;
      }
      // fallback: look for svg icons inside error Alert
      const errs = screen.queryAllByText('Login failed');
      if (errs.length) {
        const alert = errs[0].closest('.ant-alert');
        if (alert) {
          const closeInAlert = alert.querySelector('.ant-alert-close-icon') as HTMLElement | null;
          if (closeInAlert) return closeInAlert;
          const closeButtons = alert.querySelectorAll('button');
          if (closeButtons.length) return closeButtons[closeButtons.length - 1] as HTMLElement;
        }
      }
      return null as HTMLElement | null;
    })();
    if (closeBtn) fireEvent.click(closeBtn);
    await waitFor(() => {
      expect(screen.queryByText('Login failed')).not.toBeInTheDocument();
    });
  });

  it('T03.4 tampered next=javascript:alert(1) → safe /dashboard navigation', async () => {
    const us = userEvent.setup();
    const { locs } = renderLogin('/login?next=javascript%3Aalert%281%29');
    const btn = screen.getByRole('button', { name: /Connect Wallet & Sign In/i });
    await us.click(btn);
    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    await waitFor(() => {
      const last = locs[locs.length - 1];
      expect(last).toBe('/dashboard');
    });
  });

  it('T03.5 tampered next=//evil.com → safe /dashboard navigation', async () => {
    const us = userEvent.setup();
    const { locs } = renderLogin('/login?next=%2F%2Fevil.com');
    const btn = screen.getByRole('button', { name: /Connect Wallet & Sign In/i });
    await us.click(btn);
    await waitFor(() => expect(mockLogin).toHaveBeenCalled());
    await waitFor(() => {
      const last = locs[locs.length - 1];
      expect(last).toBe('/dashboard');
    });
  });
});
