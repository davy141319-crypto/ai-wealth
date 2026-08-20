'use client';

import { Alert, Button, Card, Space, Typography } from 'antd';
import { WalletOutlined } from '@ant-design/icons';

const { Title, Text } = Typography;

export default function LoginPage() {
  return (
    <main style={{ maxWidth: 480, margin: '64px auto', padding: '0 16px' }}>
      <Card>
        <Title level={3}>Wallet Login</Title>
        <Alert
          type="warning"
          showIcon
          message="P0 placeholder"
          description="Real wallet signature is disabled in P0. It will be enabled on a test network in a later phase."
        />
        <Space style={{ marginTop: 16 }}>
          <Button type="primary" icon={<WalletOutlined />} disabled>
            Connect Wallet
          </Button>
        </Space>
        <div style={{ marginTop: 12 }}>
          <Text type="secondary">No real funds are involved in P0.</Text>
        </div>
      </Card>
    </main>
  );
}
