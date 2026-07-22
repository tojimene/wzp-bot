import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.types';
import { TeamService } from './team.service';

class CreateMemberDto {
  @IsEmail() @MaxLength(160) email!: string;
  @IsString() @MinLength(8) @MaxLength(72) password!: string;
  @IsOptional() @IsString() @MaxLength(120) fullName?: string;
  @IsOptional() @IsIn(['admin', 'closer']) role?: 'admin' | 'closer';
}

class RoleOnlyDto {
  @IsIn(['admin', 'closer']) role!: 'admin' | 'closer';
}

class ResetPwDto {
  @IsString() @MinLength(8) @MaxLength(72) password!: string;
}

@Controller('team')
@UseGuards(AuthGuard)
export class TeamController {
  constructor(private readonly team: TeamService) {}

  @Get('members')
  list(@CurrentUser() user: AuthContext) {
    // El roster (emails/nombres del equipo) es material de gestión: solo admins.
    if (user.role !== 'admin') {
      throw new ForbiddenException('Solo un administrador puede ver el equipo');
    }
    return this.team.listMembers(user.organizationId);
  }

  @Post('members')
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateMemberDto) {
    return this.team.createMember(user, dto);
  }

  @Post('members/:id/role')
  role(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: RoleOnlyDto) {
    return this.team.updateRole(user, id, dto.role);
  }

  @Post('members/:id/reset-password')
  reset(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: ResetPwDto) {
    return this.team.resetPassword(user, id, dto.password);
  }

  @Delete('members/:id')
  remove(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return this.team.removeMember(user, id);
  }
}
