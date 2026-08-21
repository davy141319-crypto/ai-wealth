import { IsEnum, IsJWT, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Chain } from '@ai-wealth/database';
import { Transform } from 'class-transformer';

export class VerifyRequestDto {
  @ApiProperty({
    description: 'Full EIP-4361 A-BNF sign-in string (as signed).',
    example: 'localhost wants you to sign in with your Ethereum account:\n0x…',
  })
  @IsString()
  message!: string;

  @ApiProperty({
    description: '0x-prefixed 65-byte compact signature (r+s+v).',
    example: '0x1234…',
  })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{130}$/, { message: 'signature must be 0x + 130 hex chars (r+s+v)' })
  signature!: string;

  @ApiProperty({
    description: 'Expected signer address.',
    example: '0xA0Cf798816D4b9b9866b5330EEa46a18382f251e',
  })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'address must be 0x-prefixed EVM hex' })
  address!: string;

  @ApiProperty({ enum: ['ETH', 'BSC', 'POLYGON', 'ARBITRUM'] })
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(['ETH', 'BSC', 'POLYGON', 'ARBITRUM'] as const satisfies readonly Chain[], {
    message: 'chain must be one of ETH/BSC/POLYGON/ARBITRUM for SIWE verify',
  })
  chain!: Chain;

  @ApiProperty({ example: 'mainnet' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,32}$/)
  network!: string;
}

export class VerifyResponseDto {
  @ApiPropertyOptional({
    description:
      'HS256 access JWT. Present in api transport responses only (body). ' +
      'Cookie transport sets this as an HttpOnly cookie and omits it from the body.',
  })
  @IsOptional()
  @IsJWT()
  accessToken?: string;

  @ApiPropertyOptional({
    description:
      'Opaque refresh token. Present in api transport responses only. ' +
      'Cookie transport sets this as an HttpOnly cookie and omits it from the body.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
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

export class MeResponseDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  user!: VerifyResponseDto['user'];
}
