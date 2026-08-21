// ============================================================================
// P1-007 Admin — AdminLayout
//
// ProLayout with:
//   - Top-right: identity (short address from useAuth.user)
//   - ADMIN chip when roleState === 'ADMIN'
//   - Sign Out dropdown (logout → /login)
//   - FORBIDDEN/ERROR: hide chip, show Back to Web + Sign Out only
// ============================================================================

import { ProLayout } from '@ant-design/pro-components';
import { DashboardOutlined, GlobalOutlined, LogoutOutlined, UserOutlined } from '@ant-design/icons';
import type { MenuDataItem } from '@ant-design/pro-components';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Dropdown, Space, Tag, Typography, message } from 'antd';
import type { ReactNode } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { useAdmin } from '@/hooks/useAdmin';

const { Text } = Typography;

const menuData: MenuDataItem[] = [
  { path: '/dashboard', name: 'Dashboard', icon: <DashboardOutlined /> },
];

const WEB_APP_URL =
  (import.meta as unknown as { env?: { VITE_WEB_APP_URL?: string } }).env?.VITE_WEB_APP_URL ?? '/';

function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function getPrimaryWalletAddress(
  user: { wallets: Array<{ address: string; isPrimary: boolean }> } | null,
): string | null {
  if (!user || !user.wallets || user.wallets.length === 0) return null;
  const primary = user.wallets.find((w) => w.isPrimary) ?? user.wallets[0];
  return primary ? primary.address : null;
}

export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { logout, user } = useAuth();
  const { roleState } = useAdmin();

  const address = getPrimaryWalletAddress(user ?? null);

  async function handleSignOut() {
    try {
      await logout();
      message.success('Signed out successfully');
    } catch {
      // Coordinator will still broadcast unauthenticated
    } finally {
      navigate('/login', { replace: true });
    }
  }

  function handleBackToWeb() {
    window.location.assign(WEB_APP_URL);
  }

  const roleTag = (() => {
    if (roleState === 'ADMIN') {
      return <Tag color="green">ADMIN</Tag>;
    }
    if (roleState === 'FORBIDDEN' || roleState === 'ERROR') {
      // hide chip; dropdown provides Back to Web + Sign Out
      return null;
    }
    return <Tag color="default">...</Tag>;
  })();

  const showBackToWebItem = roleState === 'FORBIDDEN' || roleState === 'ERROR';

  const rightContentRender = () => {
    const displayName = address ? truncateAddress(address) : (user?.id ?? 'Admin');

    return (
      <Dropdown
        menu={{
          items: [
            {
              key: 'user-info',
              disabled: true,
              label: (
                <Space direction="vertical" size={0} style={{ lineHeight: 1.4 }}>
                  <Text strong>Signed in as</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {address ?? user?.id ?? '—'}
                  </Text>
                </Space>
              ),
            },
            { type: 'divider' },
            ...(showBackToWebItem
              ? [
                  {
                    key: 'back-web',
                    icon: <GlobalOutlined />,
                    label: 'Back to Web',
                    onClick: handleBackToWeb,
                  } as const,
                  { type: 'divider' as const },
                ]
              : []),
            {
              key: 'logout',
              icon: <LogoutOutlined />,
              label: 'Sign Out',
              onClick: handleSignOut,
            },
          ],
        }}
        placement="bottomRight"
        arrow
      >
        <Space style={{ cursor: 'pointer', paddingInlineEnd: 16 }} size={8}>
          {roleTag}
          <Avatar size="small" icon={<UserOutlined />} />
          <span style={{ userSelect: 'none' }}>{displayName}</span>
        </Space>
      </Dropdown>
    );
  };

  return (
    <ProLayout
      title="AI Wealth Admin"
      layout="mix"
      fixSiderbar
      location={{ pathname: location.pathname }}
      menuDataRender={() => menuData}
      menuItemRender={(item: MenuDataItem, dom: ReactNode) => (
        <div
          onClick={() => {
            if (item.path) {
              navigate(item.path);
            }
          }}
        >
          {dom}
        </div>
      )}
      rightContentRender={rightContentRender}
    >
      <Outlet />
    </ProLayout>
  );
}
