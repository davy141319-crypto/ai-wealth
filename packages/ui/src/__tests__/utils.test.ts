import { formatVersion, cx } from '../utils';

describe('ui utils', () => {
  it('formatVersion prepends v when missing', () => {
    expect(formatVersion('0.1.0')).toBe('v0.1.0');
    expect(formatVersion('v1.0.0')).toBe('v1.0.0');
  });

  it('formatVersion appends build tag when provided', () => {
    expect(formatVersion('0.1.0', 'abc123')).toBe('v0.1.0 (abc123)');
  });

  it('cx joins truthy classes and skips falsy', () => {
    expect(cx('a', false, null, 'b', undefined)).toBe('a b');
    expect(cx()).toBe('');
  });
});
