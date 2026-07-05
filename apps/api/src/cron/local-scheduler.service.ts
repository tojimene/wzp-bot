import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { MessagingService } from '../messaging/messaging.service';

/** Cada cuánto revisa el scheduler local (ms). En prod lo hace el cron de Vercel. */
const TICK_MS = 8_000;

/**
 * Scheduler EN PROCESO solo para desarrollo local (o cualquier host con proceso
 * persistente). Reproduce el trabajo del cron de Vercel llamando periódicamente
 * a `processDueResponses`/`processDueOutbox`, para que en `pnpm dev` el bot
 * responda sin necesidad de golpear el endpoint del cron a mano.
 *
 * Se DESACTIVA en Vercel (`process.env.VERCEL`), donde no hay proceso vivo entre
 * invocaciones y el trabajo lo dispara el cron real vía HTTP.
 */
@Injectable()
export class LocalSchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LocalSchedulerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly messaging: MessagingService) {}

  onModuleInit() {
    const onVercel = Boolean(process.env.VERCEL);
    const disabled = process.env.LOCAL_SCHEDULER === 'off';
    if (onVercel || disabled) return;

    this.logger.log(`Scheduler local activo (cada ${TICK_MS / 1000}s). En Vercel lo hace el cron.`);
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // No mantiene el proceso vivo por sí solo (permite cierre limpio en dev).
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick() {
    if (this.running) return; // evita solapes si un tick tarda más que el intervalo
    this.running = true;
    try {
      await Promise.all([
        this.messaging.processDueResponses(),
        this.messaging.processDueOutbox(),
      ]);
    } catch (err) {
      this.logger.error(`Error en tick local: ${String(err)}`);
    } finally {
      this.running = false;
    }
  }
}
