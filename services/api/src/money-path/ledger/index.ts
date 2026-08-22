// Thin module barrel. Keeps import sites clean: `import { LedgerEngine, validateDoubleEntry } from './ledger'`.
export * from './types';
export {
  LedgerEngine,
  validateDoubleEntry,
  validateMixedDimensionsForTests,
  coercePositiveAtomicDecimal,
  accountLockTargetsFromPlan,
} from './ledger.engine';
export type {
  WriteJournalInput,
  WriteJournalResult,
  LedgerValidationResult,
  PostingPlan,
} from './ledger.engine';
