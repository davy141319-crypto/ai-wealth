// ============================================================================
// P1-007 Admin — useAdmin hook
//
// roleState: 'verifying' | 'ADMIN' | 'FORBIDDEN' | 'ERROR'
// Trigger ensureAdmin (single-flight):
//   - auth.status becomes 'authenticated' or 'refreshing' (already authed)
//   - onAdminBusiness403 callback registered at mount → set FORBIDDEN
//
// Response rules (strict spec):
//   - 200 role=ADMIN → ADMIN
//   - 403 any → FORBIDDEN (no retry, no logout, keep session)
//   - 5xx → ERROR with retry; hard cap MAX_500_RETRIES = 2
//
// Module-level single-flight ensures concurrent mounts share one inflight.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/AuthProvider';
import { api, registerAdminForbiddenCallback } from '@/lib/api';

export type AdminRoleState = 'verifying' | 'ADMIN' | 'FORBIDDEN' | 'ERROR';

export interface AdminMeData {
  id: string;
  userId: string;
  walletId: string;
  role: string;
}

const MAX_500_RETRIES = 2;
export const ERROR_HARD_CAP_MESSAGE =
  'Admin authorization service unavailable after retries. Please contact support.';

export interface UseAdminResult {
  roleState: AdminRoleState;
  userId: string | null;
  walletId: string | null;
  retryEnsureAdmin: () => void;
  ensureAdminOnce: () => Promise<void>;
}

// ===== module-level single-flight shared across all mountings of useAdmin =====
let inflightAdminPromise: Promise<void> | null = null;

function is5xx(status: number | undefined): boolean {
  return typeof status === 'number' && status >= 500 && status < 600;
}

export function useAdmin(): UseAdminResult {
  const { status: authStatus, user: authUser } = useAuth();
  const [roleState, setRoleState] = useState<AdminRoleState>('verifying');
  const [userId, setUserId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const retries500Ref = useRef(0);
  const abortedRef = useRef(false);

  // -------- Single-flight ensureAdmin (shared at module level) --------
  const ensureAdminOnce = useCallback(async (): Promise<void> => {
    if (authStatus !== 'authenticated' && authStatus !== 'refreshing') return;
    if (inflightAdminPromise) return inflightAdminPromise;

    setRoleState((prev) => (prev === 'ADMIN' ? prev : 'verifying'));

    inflightAdminPromise = (async () => {
      try {
        const r = await api.get<{
          success: boolean;
          data?: AdminMeData & { user?: { id: string }; wallets?: Array<{ id: string }> };
        }>('/admin/me');
        if (abortedRef.current) return;
        if (r.data.success && r.data.data && r.data.data.role === 'ADMIN') {
          const d = r.data.data;
          // Prefer explicit fields on dto; fall back to first wallet/linked ids if nested.
          const resolvedUserId: string | null =
            d.userId ?? d.user?.id ?? (d as unknown as { user?: { id: string } }).user?.id ?? null;
          const resolvedWalletId: string | null =
            d.walletId ??
            (
              d as unknown as { wallets?: Array<{ id: string; isPrimary?: boolean }> }
            ).wallets?.find((w) => w.isPrimary)?.id ??
            (d as unknown as { wallets?: Array<{ id: string }> }).wallets?.[0]?.id ??
            null;
          setUserId(resolvedUserId);
          setWalletId(resolvedWalletId);
          retries500Ref.current = 0;
          setRoleState('ADMIN');
          return;
        }
        // Non-success or role !== ADMIN in success body → treat as ERROR cap
        retries500Ref.current = MAX_500_RETRIES + 1;
        setRoleState('ERROR');
      } catch (err) {
        if (abortedRef.current) return;
        const e = err as { response?: { status?: number } };
        const status = e.response?.status;
        if (status === 403) {
          retries500Ref.current = 0;
          setUserId(null);
          setWalletId(null);
          setRoleState('FORBIDDEN');
          return;
        }
        if (is5xx(status)) {
          retries500Ref.current += 1;
          if (retries500Ref.current <= MAX_500_RETRIES) {
            // allow another explicit retry (don't auto-loop here); state stays verifying → ERROR after cap
            // if call was from user retry, the next run will exceed cap.
            if (retries500Ref.current < MAX_500_RETRIES) {
              // still under cap → keep verifying so caller can re-run; only mark ERROR after cap exceeded
              setRoleState('verifying');
              return;
            }
          }
          // exceed cap → ERROR hard cap
          setRoleState('ERROR');
          return;
        }
        // Other errors → ERROR but no hard cap message; retry resets counter
        setRoleState('ERROR');
      }
    })().finally(() => {
      inflightAdminPromise = null;
    });
    return inflightAdminPromise;
  }, [authStatus]);

  const retryEnsureAdmin = useCallback((): void => {
    retries500Ref.current = 0;
    if (authStatus === 'authenticated' || authStatus === 'refreshing') {
      void ensureAdminOnce();
    } else {
      setRoleState('verifying');
    }
  }, [authStatus, ensureAdminOnce]);

  // -------- Trigger: auth transitions into authenticated/refreshing from non-authed states --------
  useEffect(() => {
    if (authStatus === 'authenticated' || authStatus === 'refreshing') {
      if (roleState === 'verifying') {
        void ensureAdminOnce();
      }
    } else if (authStatus === 'unauthenticated' || authStatus === 'initializing') {
      // session lost → reset
      abortedRef.current = false;
      retries500Ref.current = 0;
      setUserId(null);
      setWalletId(null);
      setRoleState('verifying');
      inflightAdminPromise = null; // cancel shared inflight (unauth)
    }
  }, [authStatus, roleState, ensureAdminOnce]);

  // -------- Register admin 403 broadcast callback via ESM-safe mutator --------
  useEffect(() => {
    const cb = () => {
      retries500Ref.current = 0;
      setUserId(null);
      setWalletId(null);
      setRoleState('FORBIDDEN');
    };
    registerAdminForbiddenCallback(cb);
    return () => {
      registerAdminForbiddenCallback(undefined);
    };
  }, []);

  // -------- Mount cleanup: abort flag --------
  useEffect(() => {
    abortedRef.current = false;
    return () => {
      abortedRef.current = true;
    };
  }, []);

  // Use auth user as fallback for userId/walletId (from session) when admin/me hasn't returned yet.
  const fallbackUserId = authUser?.id ?? null;
  const fallbackWalletId =
    authUser?.wallets?.find((w) => w.isPrimary)?.id ?? authUser?.wallets?.[0]?.id ?? null;

  return {
    roleState,
    userId: userId ?? fallbackUserId,
    walletId: walletId ?? fallbackWalletId,
    retryEnsureAdmin,
    ensureAdminOnce,
  };
}
