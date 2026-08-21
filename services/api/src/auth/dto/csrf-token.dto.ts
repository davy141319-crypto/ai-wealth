// ============================================================================
// DTO for GET /api/auth/csrf-token response.
// ============================================================================

import { ApiProperty } from '@nestjs/swagger';

export class CsrfTokenResponseDto {
  @ApiProperty({ description: 'Opaque CSRF token to echo in X-CSRF-TOKEN header.' })
  csrfToken!: string;
}
