// ============================================================================
// T13 / T19 — App.routes RTL tests
//
// T13 basename guard: Router basename === normalizeBasename(import.meta.env.BASE_URL)
//     - BASE_URL '/' → basename '/'
//     - BASE_URL '/admin/' → basename '/admin'
// T19 routes list: /login, /forbidden, /server-error, / (children /dashboard), * CatchAll
// ============================================================================

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { normalizeBasename } from '@/lib/basename';
import App from './App';

jest.mock('@/auth/AuthProvider', () => {
  const original = jest.requireActual('@/auth/AuthProvider');
  return {
    ...original,
    useAuth: jest.fn(),
  };
});
import { useAuth } from '@/auth/AuthProvider';

jest.mock('@/hooks/useAdmin', () => {
  const original = jest.requireActual('@/hooks/useAdmin');
  return {
    ...original,
    useAdmin: jest.fn(),
  };
});
import { useAdmin } from '@/hooks/useAdmin';

jest.mock('@/layouts/AdminLayout', () => ({
  AdminLayout: () => {
    return React.createElement(
      'div',
      { 'data-testid': 'admin-layout' },
      'LAYOUT',
      React.createElement(
        Routes,
        null,
        React.createElement(Route, {
          index: true,
          element: React.createElement('div', { 'data-testid': 'index-nav' }, 'INDEX'),
        }),
        React.createElement(Route, {
          path: 'dashboard',
          element: React.createElement('div', { 'data-testid': 'dashboard-page' }, 'DASHBOARD'),
        }),
      ),
    );
  },
}));

jest.mock('@/pages/Login', () => ({ Login: () => <div data-testid="login">LOGIN_PAGE</div> }));
jest.mock('@/pages/Forbidden', () => ({
  Forbidden: () => <div data-testid="forbidden">FORBIDDEN_PAGE</div>,
}));
jest.mock('@/pages/ServerError', () => ({
  ServerError: () => <div data-testid="server-error">SERVER_ERROR_PAGE</div>,
}));
jest.mock('@/pages/Dashboard', () => ({
  Dashboard: () => <div data-testid="dashboard-page-inner">DASHBOARD</div>,
}));

describe('T13 — basename guard', () => {
  it('T13.1 normalizeBasename("/") → "/" (BrowserRouter basename dev)', () => {
    // Verify normalization returns '/' exactly.
    expect(normalizeBasename('/')).toBe('/');
    // Simulate BrowserRouter basename property
    const TestB = () => {
      const loc = useLocation();
      return <div data-testid="loc">{loc.pathname}</div>;
    };
    const { unmount } = render(
      <BrowserRouter basename={normalizeBasename('/')}>
        <Routes>
          <Route path="/" element={<TestB />} />
        </Routes>
      </BrowserRouter>,
    );
    expect(screen.getByTestId('loc').textContent).toBe('/');
    unmount();
  });

  it('T13.2 normalizeBasename("/admin/") → "/admin" (Router basename prod)', () => {
    expect(normalizeBasename('/admin/')).toBe('/admin');
    const TestB = () => {
      const loc = useLocation();
      return <div data-testid="loc2">{loc.pathname}</div>;
    };
    const { unmount } = render(
      <MemoryRouter initialEntries={['/admin/foo']} basename={normalizeBasename('/admin/')}>
        <Routes>
          <Route path="/foo" element={<TestB />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('loc2').textContent).toBe('/foo');
    unmount();
  });
});

describe('T19 — routes enumerated', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function withEnv(auth: any, admin: any) {
    (useAuth as jest.Mock).mockReturnValue(auth);
    (useAdmin as jest.Mock).mockReturnValue(admin);
  }

  it('T19.1 /login resolves', () => {
    withEnv(
      { status: 'unauthenticated', user: null },
      { roleState: 'verifying', ensureAdminOnce: jest.fn() },
    );
    render(
      <MemoryRouter initialEntries={['/login']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('login')).toBeInTheDocument();
  });

  it('T19.2 /forbidden resolves', () => {
    withEnv(
      { status: 'authenticated', user: {} },
      { roleState: 'ADMIN', ensureAdminOnce: jest.fn() },
    );
    render(
      <MemoryRouter initialEntries={['/forbidden']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('forbidden')).toBeInTheDocument();
  });

  it('T19.3 /server-error resolves', () => {
    withEnv(
      { status: 'authenticated', user: {} },
      { roleState: 'ADMIN', ensureAdminOnce: jest.fn() },
    );
    render(
      <MemoryRouter initialEntries={['/server-error']}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('server-error')).toBeInTheDocument();
  });

  it('T19.4 protected route "/" with child "/dashboard" (mock bypass AdminLayout)', async () => {
    // Since AdminLayout component uses Outlet, and we mocked it to render OutletMock,
    // mount at protected "/" where Protected renders AdminLayout, then Outlet mock renders index or dashboard
    withEnv(
      { status: 'authenticated', user: {} },
      { roleState: 'ADMIN', ensureAdminOnce: jest.fn() },
    );
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <App />
      </MemoryRouter>,
    );
    // AdminLayout appears (since mock bypasses real Outlet using child Routes)
    await waitFor(() => {
      expect(screen.getByTestId('admin-layout')).toBeInTheDocument();
    });
  });

  it('T19.5 CatchAll "*" renders and applies matrix', async () => {
    withEnv(
      { status: 'unauthenticated', user: null },
      { roleState: 'verifying', ensureAdminOnce: jest.fn() },
    );
    render(
      <MemoryRouter initialEntries={['/unknown-path-x123']}>
        <App />
      </MemoryRouter>,
    );
    // CatchAll navigates to /login?next=
    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument();
    });
  });
});
