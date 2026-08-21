// ============================================================================
// CsrfService — Double Submit Cookie (DSC) CSRF token generation.
//
// DSC pattern: a random token is issued to the browser via a non-HttpOnly
// cookie AND returned in the response body. On state-changing requests the
// client must echo the token back in the X-CSRF-TOKEN header; the guard
// compares header === cookie. No server-side storage is required.
//
// Tokens are opaque random bytes (crypto.randomBytes) — never derived from a
// secret, never signed. They carry no claim and have no intrinsic expiry
// (rotated by re-calling GET /auth/csrf-token).
// ============================================================================

import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

@Injectable()
export class CsrfService {
  /** Issue a fresh 32-byte (256-bit) opaque token, base64url-encoded. */
  generateToken(): string {
    return randomBytes(32).toString('base64url');
  }
}
