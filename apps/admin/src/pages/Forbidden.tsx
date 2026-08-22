// ============================================================================
// P1-007 Admin — Forbidden page (role = FORBIDDEN)
// Rules: sign out ONLY via user click (no auto-logout), keep session intact.
// ============================================================================

import { Button, Result, Space } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/auth/AuthProvider';

const WEB_APP_URL =
  (import.meta as unknown as { env?: { VITE_WEB_APP_URL?: string } }).env?.VITE_WEB_APP_URL ?? '/';

export function Forbidden() {
  const navigate = useNavigate();
  const { logout } = useAuth();

  async function handleSignOut() {
    await logout();
    navigate('/login', { replace: true });
  }

  function handleBackToWeb() {
    window.location.assign(WEB_APP_URL);
  }

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        background: '#f0f2f5',
      }}
    >
      <Result
        status="403"
        title="403"
        subTitle="This account does not have Admin access."
        extra={
          <Space>
            <Button type="primary" onClick={handleSignOut}>
              Sign Out
            </Button>
            <Button onClick={handleBackToWeb}>Back to Web</Button>
          </Space>
        }
      />
    </div>
  );
}
