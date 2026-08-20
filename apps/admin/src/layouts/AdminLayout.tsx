import { ProLayout } from '@ant-design/pro-components';
import { DashboardOutlined } from '@ant-design/icons';
import type { MenuDataItem } from '@ant-design/pro-components';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { ReactNode } from 'react';

const menuData: MenuDataItem[] = [
  { path: '/dashboard', name: 'Dashboard', icon: <DashboardOutlined /> },
];

/**
 * Ant Design Pro style layout using ProLayout. Sidebar drives client-side
 * routing via React Router's <Outlet />.
 */
export function AdminLayout() {
  const location = useLocation();
  const navigate = useNavigate();

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
    >
      <Outlet />
    </ProLayout>
  );
}
