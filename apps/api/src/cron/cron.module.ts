import { Module } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { CronController } from './cron.controller';
import { LocalSchedulerService } from './local-scheduler.service';

/**
 * Procesamiento asíncrono dirigido por cron:
 *   - `CronController` expone `/api/cron/tick` para el cron de Vercel.
 *   - `LocalSchedulerService` hace el mismo trabajo en desarrollo local.
 */
@Module({
  imports: [MessagingModule, WorkflowsModule],
  controllers: [CronController],
  providers: [LocalSchedulerService],
})
export class CronModule {}
