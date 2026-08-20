'use client';

import { Alert, Card, Typography } from 'antd';

const { Title } = Typography;

export default function DashboardPage() {
  return (
    <main style={{ maxWidth: 720, margin: '64px auto', padding: '0 16px' }}>
      <Card>
        <Title level={3}>Dashboard</Title>
        <Alert
          type="info"
          showIcon
          message="P0 placeholder"
          description="Dashboard content (assets, products, earnings, tasks) is not implemented yet."
        />
      </Card>
    </main>
  );
}
