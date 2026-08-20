import { cn } from '@/lib/utils';

describe('cn', () => {
  it('joins truthy parts', () => {
    expect(cn('a', 'b')).toBe('a b');
  });

  it('skips falsy parts', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b');
  });

  it('returns empty string for no truthy parts', () => {
    expect(cn(false, null)).toBe('');
  });
});
