import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { CryptoService } from '../common/crypto.service';
import { MessagingService } from '../messaging/messaging.service';

/**
 * Cron de procesamiento asíncrono. En Vercel se configura en `vercel.json`
 * (`crons: [{ path: "/api/cron/tick", schedule: "* * * * *" }]`) y Vercel lo
 * invoca cada minuto con `Authorization: Bearer <CRON_SECRET>`. Drena:
 *   - las conversaciones cuyo debounce venció (genera y envía respuestas), y
 *   - el outbox de mensajes proactivos vencidos.
 * Es idempotente: los locks en BD evitan procesar dos veces lo mismo.
 */
@Controller('cron')
@SkipThrottle()
export class CronController {
  private readonly logger = new Logger(CronController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
    private readonly messaging: MessagingService,
  ) {}

  @Get('tick')
  async tickGet(
    @Headers('authorization') auth: string,
    @Query('secret') secret: string,
  ) {
    return this.run(auth, secret);
  }

  @Post('tick')
  async tickPost(
    @Headers('authorization') auth: string,
    @Query('secret') secret: string,
  ) {
    return this.run(auth, secret);
  }

  private async run(auth: string | undefined, secret: string | undefined) {
    const expected = this.config.get<string>('CRON_SECRET') ?? '';
    if (!expected) {
      // Sin secreto configurado no exponemos el endpoint (evita disparos anónimos).
      throw new ForbiddenException('CRON_SECRET no configurado');
    }
    const provided = (auth?.replace(/^Bearer\s+/i, '') || secret || '').trim();
    if (!this.crypto.safeEqual(provided, expected)) {
      throw new ForbiddenException('Secreto de cron inválido');
    }

    const [responses, proactive] = await Promise.all([
      this.messaging.processDueResponses(),
      this.messaging.processDueOutbox(),
    ]);
    if (responses || proactive) {
      this.logger.log(`Cron tick: ${responses} respuestas, ${proactive} proactivos`);
    }
    return { ok: true, responses, proactive };
  }
}
