import { SERVICE_NAMES } from '@ai-wealth/config';
import type { HealthState } from '@ai-wealth/shared';

export interface BlockchainHealth {
  status: HealthState;
  service: string;
  timestamp: string;
  listener: 'placeholder';
  note: string;
}

/**
 * P0 blockchain health body. The real chain listener is intentionally NOT
 * implemented yet — it must first be validated on a test network. This pure
 * builder is unit-testable without any external dependency.
 */
export function buildBlockchainHealth(): BlockchainHealth {
  return {
    status: 'ok',
    service: SERVICE_NAMES.BLOCKCHAIN,
    timestamp: new Date().toISOString(),
    listener: 'placeholder',
    note: 'Blockchain listener not implemented in P0. Real on-chain listening/verification arrives in a later phase, validated on a test network first.',
  };
}
