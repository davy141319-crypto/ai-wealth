// P1-004 — DTO for POST /api/auth/refresh.
//
// `refreshToken` is OPTIONAL: browser (cookie transport) clients send NO body
// (the token is read from the HttpOnly refresh cookie); API clients send it in
// the body. When both a cookie and a body token are present (cookie transport),
// the cookie wins (Cookie-priority) and the body value is ignored + audited.

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class RefreshRequestDto {
  @ApiPropertyOptional({
    description:
      'Refresh token (api transport only). Omit for cookie transport — the ' +
      'token is read from the HttpOnly refresh cookie. If both are present ' +
      'in cookie mode, the cookie is used and this field is ignored.',
    type: String,
  })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  refreshToken?: string;
}

export class RefreshResponseDto {
  @ApiPropertyOptional({
    description:
      'New access JWT (api transport only). Cookie transport does NOT return ' +
      'tokens in the body — they are set as HttpOnly cookies.',
    type: String,
  })
  accessToken?: string;

  @ApiPropertyOptional({
    description:
      'New rotated refresh token (api transport only). Cookie transport sets ' +
      'this as an HttpOnly cookie and never returns it in the body.',
    type: String,
  })
  refreshToken?: string;

  @ApiProperty({ description: 'Current user + wallets.' })
  user!: {
    id: string;
    status: string;
    lastLoginAt: string | null;
    wallets: Array<{
      id: string;
      address: string;
      chain: string;
      network: string;
      status: string;
      isPrimary: boolean;
    }>;
  };
}

export class LogoutRequestDto {
  @ApiPropertyOptional({
    description:
      'Refresh token (api transport only). Used to revoke the refresh family ' +
      'on logout. Cookie transport reads it from the refresh cookie.',
    type: String,
  })
  @IsOptional()
  @IsString()
  @Length(1, 256)
  refreshToken?: string;
}
