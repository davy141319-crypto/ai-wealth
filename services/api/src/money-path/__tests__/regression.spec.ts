// ============================================================================
// Lightweight regression smoke: run existing shared tests entrypoints used by
// other P1 tasks, via the api-level jest config moduleNameMapper import.
// Verifies: additive exports in @ai-wealth/database / @ai-wealth/shared do
// not break baseline type import chains; existing baseline auth/admin specs
// still pass (they live outside money-path/ folder, so here we just import
// their entry modules to prove TS resolution doesn't fail on the new
// re-exports).
// ============================================================================
import * as shared from '@ai-wealth/shared';
import * as db from '@ai-wealth/database';
import * as adminController from '../../admin/admin.controller';
import * as jwtGuard from '../../auth/jwt-auth.guard';
import * as rolesGuard from '../../auth/roles.guard';

describe('P1-008 regressions (T22)', () => {
  test('@ai-wealth/shared still exports baseline error codes + additive P1008 MoneyPathErrorCode', () => {
    expect(shared.AuthzFailReason.AUTHZ_USER_NOT_FOUND).toBeDefined();
    expect(shared.MoneyPathErrorCode.LEDGER_DOUBLE_ENTRY_VIOLATION).toBeDefined();
    expect(shared.AppErrorCode.FORBIDDEN).toBeDefined();
  });

  test('@ai-wealth/database re-exports both baseline + ledger types', () => {
    expect(db.UserRole.USER).toBeDefined();
    expect(db.LedgerTxnType.REVERSAL).toBeDefined();
    expect(db.LedgerAmountSign.DEBIT).toBeDefined();
    // Repositories aggregate now includes `ledger`.
    const r = new db.Repositories();
    expect(typeof r.ledger.createTxnWithPostings).toBe('function');
  });

  test('API existing controller modules still load (AdminController)', () => {
    expect(adminController.AdminController).toBeDefined();
  });

  test('API auth modules load (JWT guard / roles guard)', () => {
    expect(jwtGuard).toBeDefined();
    expect(rolesGuard).toBeDefined();
  });
});
