// ============================================================================
// P1-007 Admin — ProtectedAdminRoute
// Combined Auth status × Admin roleState matrix (spec §7.3).
//
// Internal paths only (no /admin/ prefix); basename handled by Router.
// Unauthenticated → /login?next=%2F<internal_path> (next stored as internal,
// never double-prefixed /admin/).
// ============================================================================

import { useEffect } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { useAuth } from '@/auth/AuthProvider';
import { useAdmin } from '@/hooks/useAdmin';

function Spinner({ tip }: { tip?: string }) {
  const text = tip ?? 'Loading...';
  return (
    <main
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '60vh',
      }}
    >
      <div style={{ textAlign: 'center' }}>
        <Spin size="large" />
        <div style={{ marginTop: 12, color: 'rgba(0,0,0,0.65)' }} data-testid="spinner-tip">
          {text}
        </div>
      </div>
    </main>
  );
}

export function ProtectedAdminRoute({ children }: { children: React.ReactNode }) {
  const { status: authStatus } = useAuth();
  const { roleState, ensureAdminOnce } = useAdmin();
  const location = useLocation();

  // Authenticated × verifying → kick off single-flight role check
  useEffect(() => {
    if (
      (authStatus === 'authenticated' || authStatus === 'refreshing') &&
      roleState === 'verifying'
    ) {
      void ensureAdminOnce();
    }
  }, [authStatus, roleState, ensureAdminOnce]);

  // ======== Fast paths: ADMIN × authed → children ========
  if ((authStatus === 'authenticated' || authStatus === 'refreshing') && roleState === 'ADMIN') {
    return <>{children}</>;
  }

  // ======== Matrix: unauthenticated ========
  if (authStatus === 'unauthenticated') {
    const next = encodeURIComponent(location.pathname || '/dashboard');
    return <Navigate to={`/login?next=${next}`} replace />;
  }

  // ======== Matrix: initializing / authenticating → Spinner (no login flash) ========
  if (authStatus === 'initializing' || authStatus === 'authenticating') {
    return <Spinner tip="Loading session..." />;
  }

  // Now: authStatus ∈ {authenticated, refreshing} AND roleState ≠ ADMIN
  if (authStatus === 'authenticated' || authStatus === 'refreshing') {
    if (roleState === 'verifying') {
      return <Spinner tip="Checking admin role..." />;
    }
    if (roleState === 'FORBIDDEN') {
      return <Navigate to="/forbidden" replace />;
    }
    if (roleState === 'ERROR') {
      return <Navigate to="/server-error" replace />;
    }
  }

  // Fallback (should not be reached): Spinner
  return <Spinner tip="Loading..." />;
}
