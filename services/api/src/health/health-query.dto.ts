import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Demonstrates P0 input-validation convention (DTO + class-validator + Swagger).
 * `verbose=true` returns the full per-dependency health breakdown.
 */
export class HealthQueryDto {
  @ApiPropertyOptional({ description: 'Return full dependency checks', default: false })
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  verbose?: boolean;
}
