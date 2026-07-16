import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const TRIGGERS = ['lead_created', 'manual', 'stage'] as const;

export class CreateWorkflowDto {
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsOptional() @IsIn(TRIGGERS) trigger?: (typeof TRIGGERS)[number];
  @IsOptional() @IsObject() trigger_config?: Record<string, unknown>;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(8760) resume_after_hours?: number;
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(TRIGGERS) trigger?: (typeof TRIGGERS)[number];
  @IsOptional() @IsObject() trigger_config?: Record<string, unknown>;
  @IsOptional() @IsBoolean() is_active?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(8760) resume_after_hours?: number;
  @IsOptional() @IsObject() definition?: Record<string, unknown>;
}

export class EnrollDto {
  @IsUUID() conversationId!: string;
}
