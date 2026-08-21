// ============================================================================
// P1-007 Admin — ServerError page (role = ERROR after hard cap)
// Rules: keep authenticated, never logout, retry with hard cap N=2.
// ============================================================================

import { Button, Result, Space, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAdmin, ERROR_HARD_CAP_MESSAGE } from '@/hooks/useAdmin';

const { Text } = Typography;

export function ServerError() {
  const navigate = useNavigate();
  const { roleState, retryEnsureAdmin } = useAdmin();

  // Render static "contact support" when ERROR state (already exceeded hard cap)
  const showContactSupport = roleState === 'ERROR';

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
        status="500"
        title="500"
        subTitle="Admin authorization service unavailable."
        extra={
          <Space>
            <Button type="primary" onClick={() => retryEnsureAdmin()}>
              Retry
            </Button>
            <Button onClick={() => navigate('/login', { replace: true })}>Back to Login</Button>
          </Space>
        }
      >
        <div style={{ textAlign: 'center', maxWidth: 520, margin: '0 auto' }}>
          <Text type="secondary">
            Your active session is preserved — no automatic logout occurs during role-check server
            errors.
          </Text>
          {showContactSupport && (
            <div style={{ marginTop: 8 }}>
              <Text type="warning">{ERROR_HARD_CAP_MESSAGE}</Text>
            </div>
          )}
        </div>
      </Result>
    </div>
  );
}
