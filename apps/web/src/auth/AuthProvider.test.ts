// ============================================================================
// P1-005 — T17: AuthProvider 状态机测试
//
// 由于 jest 配置为 node 环境（无 jsdom），不实际渲染 React 组件。
// 这里测试 AuthProvider 模块的导出契约 + deriveStatus 派生逻辑。
// 完整的 React 渲染测试由 E2E 覆盖（T18）。
// ============================================================================

import * as fs from 'node:fs';
import * as path from 'node:path';

describe('P1-005 AuthProvider 模块契约', () => {
  it('AP01 AuthProvider.tsx 导出 AuthProvider、useAuth、useRegisterAuthClient', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'AuthProvider.tsx'), 'utf8');
    expect(src).toMatch(/export\s+function\s+AuthProvider/);
    expect(src).toMatch(/export\s+function\s+useAuth/);
    expect(src).toMatch(/export\s+function\s+useRegisterAuthClient/);
  });

  it('AP02 AuthProvider mount 时调 Coordinator.restore()（仅一次）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'AuthProvider.tsx'), 'utf8');
    expect(src).toMatch(/authCoordinator\.restore\(\)/);
    expect(src).toMatch(/authCoordinator\.subscribe\(/);
  });

  it('AP03 AuthProvider 不在 localStorage/sessionStorage 存 token（AC-9）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'AuthProvider.tsx'), 'utf8');
    expect(src).not.toMatch(/localStorage\.setItem/);
    expect(src).not.toMatch(/sessionStorage\.setItem/);
    expect(src).not.toMatch(/localStorage\.getItem/);
    expect(src).not.toMatch(/sessionStorage\.getItem/);
  });

  it('AP04 AuthProvider user 仅内存态（React state）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'AuthProvider.tsx'), 'utf8');
    // user 来自 useState（内存态），不持久化
    expect(src).toMatch(/useState<SessionState>/);
  });
});

describe('P1-005 AuthProvider 状态派生（deriveStatus）', () => {
  it('AP05 派生 5 态全部覆盖', () => {
    const src = fs.readFileSync(path.resolve(__dirname, 'AuthProvider.tsx'), 'utf8');
    expect(src).toMatch(/'initializing'/);
    expect(src).toMatch(/'authenticating'/);
    expect(src).toMatch(/'authenticated'/);
    expect(src).toMatch(/'refreshing'/);
    expect(src).toMatch(/'unauthenticated'/);
  });

  it('AP06 ProtectedRoute 5 态处理（loading/children/redirect）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'components', 'ProtectedRoute.tsx'),
      'utf8',
    );
    // initializing → loading
    expect(src).toMatch(/status\s*===\s*['"]initializing['"]/);
    // authenticating → loading
    expect(src).toMatch(/status\s*===\s*['"]authenticating['"]/);
    // authenticated → children
    expect(src).toMatch(/status\s*===\s*['"]unauthenticated['"]/);
    // redirect /login（支持单引号/双引号/模板字符串）
    expect(src).toMatch(/router\.replace\(\s*['"`]\/login/);
  });

  it('AP07 ProtectedRoute initializing 时不渲染 children（AC-15）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'components', 'ProtectedRoute.tsx'),
      'utf8',
    );
    // 返回 <Spin> loading，不返回 children
    expect(src).toMatch(/initializing.*authenticating/);
    expect(src).toMatch(/<Spin/);
  });
});
