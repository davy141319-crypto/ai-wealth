import { Alert, Button, Card, Form, Input, Typography } from 'antd';

export function Login() {
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
      <Card style={{ width: 380 }}>
        <Typography.Title level={3} style={{ marginBottom: 8 }}>
          AI Wealth Admin
        </Typography.Title>
        <Alert
          type="info"
          showIcon
          message="P0 placeholder"
          description="No real admin authentication in P0. RBAC/permissions arrive in a later phase."
          style={{ marginBottom: 16 }}
        />
        <Form
          layout="vertical"
          onFinish={() => {
            /* no real auth in P0 */
          }}
        >
          <Form.Item label="Username" name="username">
            <Input placeholder="admin" autoComplete="username" />
          </Form.Item>
          <Form.Item label="Password" name="password">
            <Input.Password placeholder="••••••••" autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block disabled>
            Login
          </Button>
        </Form>
      </Card>
    </div>
  );
}
