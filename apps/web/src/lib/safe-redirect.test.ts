// ============================================================================
// P1-005 修订（Fix 3）— safeRedirectTarget 安全重定向校验测试
//
// 覆盖：
//   - 合法本站相对路径放行（带 query / fragment / 嵌套路径）
//   - 非法值 fallback /dashboard：
//     - 无 / 空
//     - 不以 / 开头（绝对 URL、scheme、相对路径）
//     - 协议相对 //evil.com
//     - 反斜杠绕过 /\evil.com、路径含反斜杠
//     - 控制字符
//     - 伪协议 /javascript:alert(1)
// ============================================================================

import { safeRedirectTarget, DEFAULT_REDIRECT_TARGET } from './safe-redirect';

describe('P1-005 Fix 3: safeRedirectTarget — 合法值放行', () => {
  it('SR01 null / undefined / 空 → fallback', () => {
    expect(safeRedirectTarget(null)).toBe('/dashboard');
    expect(safeRedirectTarget(undefined)).toBe('/dashboard');
    expect(safeRedirectTarget('')).toBe('/dashboard');
  });

  it('SR02 单 / → 放行', () => {
    expect(safeRedirectTarget('/')).toBe('/');
  });

  it('SR03 /dashboard → 放行', () => {
    expect(safeRedirectTarget('/dashboard')).toBe('/dashboard');
  });

  it('SR04 带 query / fragment / 嵌套路径 → 放行', () => {
    expect(safeRedirectTarget('/dashboard?tab=assets')).toBe('/dashboard?tab=assets');
    expect(safeRedirectTarget('/dashboard#section')).toBe('/dashboard#section');
    expect(safeRedirectTarget('/users/me/settings')).toBe('/users/me/settings');
    expect(safeRedirectTarget('/a?b=c&d=e#f')).toBe('/a?b=c&d=e#f');
  });

  it('SR05 自定义 fallback 生效', () => {
    expect(safeRedirectTarget(null, '/home')).toBe('/home');
    expect(safeRedirectTarget('//evil.com', '/home')).toBe('/home');
  });

  it('SR06 DEFAULT_REDIRECT_TARGET === /dashboard', () => {
    expect(DEFAULT_REDIRECT_TARGET).toBe('/dashboard');
  });
});

describe('P1-005 Fix 3: safeRedirectTarget — 非法值 fallback', () => {
  it('SR07 不以 / 开头 → fallback（绝对 URL / scheme / 相对路径）', () => {
    expect(safeRedirectTarget('http://evil.com')).toBe('/dashboard');
    expect(safeRedirectTarget('https://evil.com')).toBe('/dashboard');
    expect(safeRedirectTarget('javascript:alert(1)')).toBe('/dashboard');
    expect(safeRedirectTarget('data:text/html,<script>')).toBe('/dashboard');
    expect(safeRedirectTarget('relative/path')).toBe('/dashboard');
    expect(safeRedirectTarget('evil.com')).toBe('/dashboard');
  });

  it('SR08 协议相对 //evil.com → fallback', () => {
    expect(safeRedirectTarget('//evil.com')).toBe('/dashboard');
    expect(safeRedirectTarget('//evil.com/path')).toBe('/dashboard');
  });

  it('SR09 反斜杠绕过 /\\evil.com → fallback', () => {
    expect(safeRedirectTarget('/\\evil.com')).toBe('/dashboard');
    expect(safeRedirectTarget('\\evil.com')).toBe('/dashboard');
  });

  it('SR10 路径含反斜杠 → fallback', () => {
    expect(safeRedirectTarget('/dashboard\\evil')).toBe('/dashboard');
    expect(safeRedirectTarget('/a\\b')).toBe('/dashboard');
  });

  it('SR11 控制字符（tab/换行/回车）→ fallback', () => {
    expect(safeRedirectTarget('/\tevil')).toBe('/dashboard');
    expect(safeRedirectTarget('/\nevil')).toBe('/dashboard');
    expect(safeRedirectTarget('/\revil')).toBe('/dashboard');
  });

  it('SR12 伪协议 /javascript:alert(1) → fallback', () => {
    expect(safeRedirectTarget('/javascript:alert(1)')).toBe('/dashboard');
    expect(safeRedirectTarget('/vbscript:msgbox')).toBe('/dashboard');
  });

  it('SR13 合法路径首段含 query 但无冒号 → 放行（回归：不误判正常路径）', () => {
    // /dashboard?x=http://y 含冒号但不在首段 → 放行
    expect(safeRedirectTarget('/dashboard?next=http://evil')).toBe('/dashboard?next=http://evil');
  });
});
