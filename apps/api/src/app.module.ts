import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { CommonModule } from './common/common.module';
import { AdminModule } from './admin/admin.module';
import { AuthModule } from './auth/auth.module';
import { CalendarModule } from './calendar/calendar.module';
import { ChannelsModule } from './channels/channels.module';
import { CronModule } from './cron/cron.module';
import { HealthController } from './health/health.controller';
import { TeamModule } from './team/team.module';
import { InboxModule } from './inbox/inbox.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { LeadsModule } from './leads/leads.module';
import { MessagingModule } from './messaging/messaging.module';
import { OpenRouterModule } from './openrouter/openrouter.module';
import { PlaygroundModule } from './playground/playground.module';
import { SetterModule } from './setter/setter.module';
import { SupabaseModule } from './supabase/supabase.module';
import { UnipileModule } from './unipile/unipile.module';
import { WhatsAppCloudModule } from './whatsapp-cloud/whatsapp-cloud.module';
import { WebhooksModule } from './webhooks/webhooks.module';

@Module({
  imports: [
    // Carga variables de entorno. La API corre desde apps/api, así que el .env
    // de la raíz del monorepo está dos niveles arriba.
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['../../.env', '.env'],
    }),
    // Rate limiting global anti abuso/fuerza bruta: 120 req/min por IP por
    // defecto (los endpoints públicos sensibles aplican límites más estrictos).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    CommonModule,
    AuthModule,
    AdminModule,
    TeamModule,
    SupabaseModule,
    UnipileModule,
    WhatsAppCloudModule,
    OpenRouterModule,
    ChannelsModule,
    CalendarModule,
    SetterModule,
    PlaygroundModule,
    MessagingModule,
    CronModule,
    InboxModule,
    LeadsModule,
    IntegrationsModule,
    WebhooksModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
