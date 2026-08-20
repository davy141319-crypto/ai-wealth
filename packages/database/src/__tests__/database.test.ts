import { prisma, dbHealth } from '../index';

describe('database package exports', () => {
  it('exposes a prisma client singleton', () => {
    expect(prisma).toBeDefined();
    expect(typeof prisma.$queryRaw).toBe('function');
  });

  it('exposes a dbHealth probe function', () => {
    expect(typeof dbHealth).toBe('function');
  });
});
