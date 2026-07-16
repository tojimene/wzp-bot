import {
  IsBoolean,
  IsHexColor,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { FUNNEL_STAGES } from '../tags.types';

export class CreateTagDto {
  @IsString() @MinLength(1) @MaxLength(60) name!: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @IsOptional() @IsIn(FUNNEL_STAGES) set_stage?: (typeof FUNNEL_STAGES)[number] | null;
  @IsOptional() @IsBoolean() ai_enabled?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}

export class UpdateTagDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(60) name?: string;
  @IsOptional() @IsHexColor() color?: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string | null;
  @IsOptional() @IsIn([...FUNNEL_STAGES]) set_stage?: (typeof FUNNEL_STAGES)[number] | null;
  @IsOptional() @IsBoolean() ai_enabled?: boolean;
  @IsOptional() @IsInt() sort_order?: number;
}

export class ApplyTagDto {
  @IsString() @MinLength(1) @MaxLength(64) tagId!: string;
}
