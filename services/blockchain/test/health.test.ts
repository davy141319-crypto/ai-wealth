import { buildBlockchainHealth } from '../src/health';

describe('buildBlockchainHealth', () => {
  it('returns an ok placeholder status', () => {
    const body = buildBlockchainHealth();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('blockchain');
    expect(body.listener).toBe('placeholder');
    expect(typeof body.timestamp).toBe('string');
    expect(body.note).toContain('test network');
  });
});
