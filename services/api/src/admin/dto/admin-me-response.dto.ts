// ============================================================================
// DTO for GET /api/admin/me response (P1-007 Admin Auth Integration contract).
// ============================================================================

import { ApiProperty } from '@nestjs/swagger';

export class AdminMeResponseDto {
  @ApiProperty({
    description: 'Authenticated user id.',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  userId!: string;

  @ApiProperty({
    description: 'Live DB role (never a JWT claim).',
    enum: ['USER', 'ADMIN'],
    example: 'ADMIN',
  })
  role!: 'USER' | 'ADMIN';

  @ApiProperty({
    description: 'Wallet id from the authenticated session, or null for Bearer-only clients.',
    nullable: true,
    example: '660e8400-e29b-41d4-a716-446655440000',
  })
  walletId!: string | null;
}
