import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { Chain } from '@ai-wealth/database';
import { Transform } from 'class-transformer';

/** DTO for GET /auth/nonce?address=&chain=&network= */
export class NonceQueryDto {
  @ApiProperty({
    description: 'EVM wallet address (0x + 40 hex chars, checksummed or not).',
    example: '0xA0Cf798816D4b9b9866b5330EEa46a18382f251e',
  })
  @IsString()
  @Matches(/^0x[a-fA-F0-9]{40}$/, { message: 'address must be 0x-prefixed EVM hex' })
  address!: string;

  @ApiProperty({
    description: 'Chain enum. TRON not supported in P1-002.',
    enum: ['ETH', 'BSC', 'POLYGON', 'ARBITRUM', 'TRON'],
    example: 'ETH',
  })
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(['ETH', 'BSC', 'POLYGON', 'ARBITRUM', 'TRON'] as const satisfies readonly Chain[], {
    message: 'chain must be one of ETH/BSC/POLYGON/ARBITRUM/TRON',
  })
  chain!: Chain;

  @ApiProperty({
    description: 'Logical network on the chain (mainnet / sepolia / …).',
    example: 'mainnet',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,32}$/, {
    message: 'network must be 1-32 alphanumeric/dash/underscore chars',
  })
  network!: string;
}

export class NonceResponseDto {
  @ApiProperty({ description: 'Server-issued 32-byte random nonce (hex).' })
  nonce!: string;
  @ApiProperty() issuedAt!: Date;
  @ApiProperty() expiresAt!: Date;
  @ApiProperty() domain!: string;
  @ApiProperty() uri!: string;
  @ApiProperty({ required: false })
  @IsOptional()
  statement?: string;
  @ApiProperty() chainId!: number;
}
