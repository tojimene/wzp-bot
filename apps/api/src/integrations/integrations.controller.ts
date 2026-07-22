import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.types';
import { IntegrationsService } from './integrations.service';

class UpdateIntegrationDto {
  @IsOptional() @IsString() @MaxLength(300) manychat_api_key?: string;
  @IsOptional() @IsUUID() default_channel_id?: string;
  @IsOptional() @IsBoolean() proactive_enabled?: boolean;
  // URL de salida a la que el backend hace POST: exigimos https y validamos el
  // host contra SSRF en el servicio (ver assertSafeWebhookUrl). Cadena vacía = borrar.
  @IsOptional()
  @IsString()
  @MaxLength(500)
  // Solo validamos formato de URL cuando NO es cadena vacía (vacío = borrar).
  @ValidateIf((o) => typeof o.ghl_webhook_url === 'string' && o.ghl_webhook_url.trim() !== '')
  @IsUrl({ protocols: ['https'], require_protocol: true }, { message: 'La URL del webhook debe usar https' })
  ghl_webhook_url?: string;
}

@Controller('integrations')
@UseGuards(AuthGuard)
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get()
  async get(@CurrentUser() user: AuthContext) {
    const cfg = await this.integrations.getOrCreate(user.organizationId);
    // Los secretos (token de intake, API key, URLs con token) son solo para
    // admins. Un closer recibe una vista sin material sensible.
    if (user.role !== 'admin') {
      return {
        organization_id: cfg.organization_id,
        default_channel_id: cfg.default_channel_id,
        proactive_enabled: cfg.proactive_enabled,
        manychat_api_key: cfg.manychat_api_key ? '••••••••' : null,
      };
    }
    return { ...cfg, urls: this.integrations.buildUrls(cfg.intake_token) };
  }

  @Put()
  async update(@CurrentUser() user: AuthContext, @Body() dto: UpdateIntegrationDto) {
    this.assertAdmin(user);
    const cfg = await this.integrations.update(user.organizationId, dto);
    return { ...cfg, urls: this.integrations.buildUrls(cfg.intake_token) };
  }

  @Post('rotate-token')
  async rotate(@CurrentUser() user: AuthContext) {
    this.assertAdmin(user);
    const cfg = await this.integrations.rotateToken(user.organizationId);
    return { ...cfg, urls: this.integrations.buildUrls(cfg.intake_token) };
  }

  private assertAdmin(user: AuthContext) {
    if (user.role !== 'admin') {
      throw new ForbiddenException('Solo un administrador puede editar las integraciones');
    }
  }
}
