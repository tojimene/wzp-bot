import { Module } from '@nestjs/common';
import { SetterModule } from '../setter/setter.module';
import { CalendarModule } from '../calendar/calendar.module';
import { TagsModule } from '../tags/tags.module';
import { MessagingService } from './messaging.service';
import { TransportService } from './transport.service';

/**
 * Mensajería sin colas persistentes: el procesamiento asíncrono (respuestas
 * agrupadas y envíos proactivos con throttling) está dirigido por la BD y lo
 * drena el cron (`/api/cron/tick` en Vercel) o el scheduler local en desarrollo.
 * Así todo puede desplegarse como funciones serverless, sin workers encendidos.
 */
@Module({
  imports: [SetterModule, CalendarModule, TagsModule],
  providers: [MessagingService, TransportService],
  exports: [MessagingService, TransportService],
})
export class MessagingModule {}
