import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { MessagingModule } from '../messaging/messaging.module';
import { WorkflowsController } from './workflows.controller';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngineService } from './workflow-engine.service';

/**
 * Workflows / seguimientos (árbol de nodos). El motor reutiliza MessagingService
 * (envíos con throttling vía outbox). No dependas de este módulo desde
 * MessagingModule para evitar ciclos: la pausa por respuesta la hace Messaging
 * escribiendo directamente en `workflow_runs`.
 */
@Module({
  imports: [MessagingModule],
  controllers: [WorkflowsController],
  providers: [WorkflowsService, WorkflowEngineService, AuthGuard],
  exports: [WorkflowsService, WorkflowEngineService],
})
export class WorkflowsModule {}
