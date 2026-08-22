// ============================================================================
// P1-007 Admin — App routes
// INTERNAL paths only (no /admin/ prefixes); basename from <BrowserRouter>
// prepends /admin in production automatically.
//
// Routes:
//   /login              → Login
//   /forbidden          → Forbidden
//   /server-error       → ServerError
//   / (protected)       → ProtectedAdminRoute → AdminLayout → routes:
//       index           → Navigate to /dashboard
//       /dashboard      → Dashboard
//   *                   → CatchAll (redirect per auth×role matrix)
// Guards wired. Remove old "Guards added later" placeholder.
// ============================================================================

import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { Spin } from 'antd';
import { AdminLayout } from '@/layouts/AdminLayout';
import { Login } from '@/pages/Login';
import { Dashboard } from '@/pages/Dashboard';
import { Forbidden } from '@/pages/Forbidden';
import { ServerError } from '@/pages/ServerError';
import { ProtectedAdminRoute } from '@/components/ProtectedAdminRoute';
import { useAuth } from '@/auth/AuthProvider';
import { useAdmin } from '@/hooks/useAdmin';

/**
 * Catch-all route: applies the auth×role matrix to determine redirect target.
 * Runs when no other route matches.
 */
function CatchAll() {
  const { status: authStatus } = useAuth();
  const { roleState } = useAdmin();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (authStatus === 'unauthenticated') {
      const next = encodeURIComponent(location.pathname || '/dashboard');
      navigate(`/login?next=${next}`, { replace: true });
      return;
    }
    if (
      authStatus === 'initializing' ||
      authStatus === 'authenticating' ||
      roleState === 'verifying'
    ) {
      return; // Spinner shown
    }
    if (roleState === 'FORBIDDEN') {
      navigate('/forbidden', { replace: true });
      return;
    }
    if (roleState === 'ERROR') {
      navigate('/server-error', { replace: true });
      return;
    }
    if ((authStatus === 'authenticated' || authStatus === 'refreshing') && roleState === 'ADMIN') {
      navigate('/dashboard', { replace: true });
      return;
    }
    navigate('/dashboard', { replace: true });
  }, [authStatus, roleState, navigate, location.pathname]);

  if (
    authStatus === 'initializing' ||
    authStatus === 'authenticating' ||
    roleState === 'verifying'
  ) {
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
            Loading...
          </div>
        </div>
      </main>
    );
  }
  return null;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forbidden" element={<Forbidden />} />
      <Route path="/server-error" element={<ServerError />} />

      <Route
        path="/"
        element={
          <ProtectedAdminRoute>
            <AdminLayout />
          </ProtectedAdminRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
      </Route>

      <Route path="*" element={<CatchAll />} />
    </Routes>
  );
}
