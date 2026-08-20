import {
  normalizePagination,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../types';

describe('normalizePagination', () => {
  it('applies defaults when input is empty', () => {
    const r = normalizePagination({});
    expect(r.page).toBe(DEFAULT_PAGE);
    expect(r.pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(r.skip).toBe(0);
    expect(r.take).toBe(DEFAULT_PAGE_SIZE);
  });

  it('respects provided page/pageSize', () => {
    const r = normalizePagination({ page: 3, pageSize: 50 });
    expect(r.page).toBe(3);
    expect(r.pageSize).toBe(50);
    expect(r.skip).toBe(100); // (3-1)*50
    expect(r.take).toBe(50);
  });

  it('clamps pageSize to MAX_PAGE_SIZE', () => {
    const r = normalizePagination({ page: 1, pageSize: 9999 });
    expect(r.pageSize).toBe(MAX_PAGE_SIZE);
    expect(r.take).toBe(MAX_PAGE_SIZE);
  });

  it('clamps pageSize to a minimum of 1', () => {
    const r = normalizePagination({ page: 1, pageSize: 0 });
    expect(r.pageSize).toBe(1);
  });

  it('clamps page to a minimum of 1', () => {
    const r = normalizePagination({ page: -5, pageSize: 10 });
    expect(r.page).toBe(1);
    expect(r.skip).toBe(0);
  });

  it('floors fractional inputs', () => {
    const r = normalizePagination({ page: 2.9, pageSize: 15.7 });
    expect(r.page).toBe(2);
    expect(r.pageSize).toBe(15);
    expect(r.skip).toBe(15); // (2-1)*15
  });
});
