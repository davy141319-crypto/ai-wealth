'use client';

import { Button, Card, Space, Typography } from 'antd';
import Link from 'next/link';

const { Title, Paragraph } = Typography;

export default function HomePage() {
  return (
    <main style={{ maxWidth: 720, margin: '64px auto', padding: '0 16px' }}>
      <Card>
        <Title level={2}>AI Wealth DApp</Title>
        <Paragraph>
          P0 foundation is live. Web3 wallet login, USDT assets, wealth products, settlement,
          points, tasks, invitations, teams and withdrawals arrive in later phases — always
          validated on a test network first.
        </Paragraph>
        <Space>
          <Link href="/login">
            <Button type="primary">Login</Button>
          </Link>
          <Link href="/dashboard">
            <Button>Dashboard</Button>
          </Link>
        </Space>
      </Card>
    </main>
  );
}
