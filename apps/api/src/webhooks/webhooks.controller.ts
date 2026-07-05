import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import { ChannelsService } from '../channels/channels.service';
import { MessagingService } from '../messaging/messaging.service';
import { CalendarService } from '../calendar/calendar.service';
import { AppointmentsService } from '../calendar/appointments.service';
import { CryptoService } from '../common/crypto.service';

/**
 * Endpoints PÚBLICOS (sin JWT) que recibe Unipile. La autenticidad se valida con
 * un secreto compartido (UNIPILE_WEBHOOK_SECRET): por query en el callback de
 * cuenta y por header en el de mensajería.
 */
@Controller('webhooks/unipile')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly channels: ChannelsService,
    private readonly messaging: MessagingService,
    private readonly calendar: CalendarService,
    private readonly appointments: AppointmentsService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
  ) {}

  private get secret(): string {
    return this.config.getOrThrow<string>('UNIPILE_WEBHOOK_SECRET');
  }

  /** Callback `notify_url` del hosted auth: una cuenta terminó de conectarse. */
  @Post('account')
  @HttpCode(200)
  async account(
    @Query('secret') secret: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.crypto.safeEqual(secret, this.secret)) {
      throw new ForbiddenException('Secreto inválido');
    }

    this.logger.log(`Webhook cuenta: status=${String(body.status)} account=${String(body.account_id)}`);
    await this.channels.handleAccountWebhook({
      status: body.status as string | undefined,
      account_id: body.account_id as string | undefined,
      name: body.name as string | undefined,
    });

    return { ok: true };
  }

  /**
   * Webhook de mensajería (mensajes nuevos). Guardamos el mensaje al vuelo y
   * respondemos 200; la GENERACIÓN de la respuesta IA (con retardos humanos) la
   * hace el cron cuando vence la ventana de debounce, para no bloquear el webhook.
   */
  @Post('messaging')
  @HttpCode(200)
  // Webhook de alto volumen desde IPs de Unipile: límite generoso (protegido por
  // secreto y encolado), pero acotado para no quedar a merced de un flood.
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  async incomingMessage(
    @Headers('unipile-auth') auth: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.crypto.safeEqual(auth, this.secret)) {
      throw new ForbiddenException('Secreto inválido');
    }

    this.logger.log(`Mensaje entrante (account ${String(body.account_id)})`);
    // Guardamos el mensaje y programamos la respuesta (respond_after). El cron
    // la generará y enviará al vencer el debounce. Respondemos 200 al instante.
    await this.messaging.enqueueIncoming(body);
    return { ok: true };
  }

  /** Callback `notify_url` del hosted auth de un CALENDARIO conectado. */
  @Post('calendar-account')
  @HttpCode(200)
  async calendarAccount(
    @Query('secret') secret: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.crypto.safeEqual(secret, this.secret)) {
      throw new ForbiddenException('Secreto inválido');
    }
    this.logger.log(`Webhook calendario: status=${String(body.status)} account=${String(body.account_id)}`);
    await this.calendar.handleAccountWebhook({
      status: body.status as string | undefined,
      account_id: body.account_id as string | undefined,
      name: body.name as string | undefined,
    });
    return { ok: true };
  }

  /** Webhook de eventos de calendario (cita creada/cancelada → tag). */
  @Post('calendar-event')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 300 } })
  async calendarEvent(
    @Headers('unipile-auth') auth: string,
    @Query('secret') secret: string,
    @Body() body: Record<string, unknown>,
  ) {
    if (!this.crypto.safeEqual(auth || secret, this.secret)) {
      throw new ForbiddenException('Secreto inválido');
    }
    await this.appointments.handleEventWebhook(body);
    return { ok: true };
  }
}
