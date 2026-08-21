'use client';

// ============================================================================
// P1-005 — Dashboard 页面
// 包裹 ProtectedRoute，显示当前 user（地址、钱包列表），添加 logout 按钮。
// ============================================================================

import { Alert, Button, Card, Space, Typography, Divider } from 'antd';
import { LogoutOutlined } from '@ant-design/icons';
import { useRouter } from 'next/navigation';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { useAuth } from '@/auth/AuthProvider';

const { Title, Text, Paragraph } = Typography;

function DashboardContent() {
  const { user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace('/');
  }

  return (
    <main style={{ maxWidth: 720, margin: '64px auto', padding: '0 16px' }}>
      <Card>
        <Title level={3}>Dashboard</Title>

        <Alert
          type="success"
          showIcon
          message="Session authenticated"
          description="Your wallet session is active. P0 business content (assets, products, earnings, tasks) is not implemented yet."
        />

        <Divider />

        <Paragraph>
          <Text strong>User ID:</Text> <Text code>{user?.id ?? '—'}</Text>
        </Paragraph>
        <Paragraph>
          <Text strong>Status:</Text> <Text code>{user?.status ?? '—'}</Text>
        </Paragraph>

        <Divider />

        <Title level={5}>Wallets</Title>
        {user?.wallets?.length ? (
          user.wallets.map((w) => (
            <Paragraph key={w.id}>
              <Text code>{w.address}</Text>
              <br />
              <Text type="secondary">
                {w.chain} / {w.network} · {w.isPrimary ? 'Primary' : 'Secondary'} · {w.status}
              </Text>
            </Paragraph>
          ))
        ) : (
          <Text type="secondary">No wallets linked.</Text>
        )}

        <Divider />

        <Space>
          <Button type="primary" danger icon={<LogoutOutlined />} onClick={handleLogout}>
            Logout
          </Button>
        </Space>
      </Card>
    </main>
  );
}

export default function DashboardPage() {
  return (
    <ProtectedRoute>
      <DashboardContent />
    </ProtectedRoute>
  );
}
