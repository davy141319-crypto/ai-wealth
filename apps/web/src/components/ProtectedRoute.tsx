'use client';

// ============================================================================
// P1-005 — ProtectedRoute 客户端守卫
//
// 行为（spec v3 修订）：
//   - status='initializing' → 渲染 loading（不 redirect，不渲染 children）
//   - status='authenticating' → 渲染 loading（不 redirect）
//   - status='authenticated' → 渲染 children
//   - status='refreshing' → 渲染 children（保持当前视图，后台刷新）
//   - status='unauthenticated' → redirect /login?next=<original>
//
// ⚠️ 初始化全过程（即使内部执行了 refresh）：始终 initializing → loading
//    绝不渲染 children，绝不 redirect（直到恢复完成才转 authenticated/unauthenticated）
// ============================================================================

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { Spin } from 'antd';
import { useAuth } from '@/auth/AuthProvider';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'unauthenticated') {
      const next = encodeURIComponent(pathname || '/dashboard');
      router.replace(`/login?next=${next}`);
    }
  }, [status, router, pathname]);

  if (status === 'initializing' || status === 'authenticating') {
    return (
      <main
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          minHeight: '60vh',
        }}
      >
        <Spin size="large" tip="Loading session..." />
      </main>
    );
  }

  if (status === 'unauthenticated') {
    // 即将 redirect，渲染空（避免闪现受保护内容）
    return null;
  }

  // status === 'authenticated' || status === 'refreshing'
  return <>{children}</>;
}
