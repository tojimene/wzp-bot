import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthContext } from '../auth/auth.types';
import { WorkflowsService } from './workflows.service';
import { WorkflowEngineService } from './workflow-engine.service';
import { CreateWorkflowDto, EnrollDto, UpdateWorkflowDto } from './dto/workflow.dto';
import type { WorkflowDefinition } from './workflows.types';

@Controller('workflows')
@UseGuards(AuthGuard)
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly engine: WorkflowEngineService,
  ) {}

  @Get()
  list(@CurrentUser() user: AuthContext) {
    return this.workflows.list(user.organizationId);
  }

  @Post()
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateWorkflowDto) {
    return this.workflows.create(user.organizationId, user.userId, {
      name: dto.name,
      trigger: dto.trigger,
      trigger_config: dto.trigger_config,
      resume_after_hours: dto.resume_after_hours,
      definition: dto.definition as unknown as WorkflowDefinition | undefined,
    });
  }

  @Get(':id')
  get(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return this.workflows.get(user.organizationId, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthContext, @Param('id') id: string, @Body() dto: UpdateWorkflowDto) {
    return this.workflows.update(user.organizationId, id, {
      name: dto.name,
      trigger: dto.trigger,
      trigger_config: dto.trigger_config,
      is_active: dto.is_active,
      resume_after_hours: dto.resume_after_hours,
      definition: dto.definition as unknown as WorkflowDefinition | undefined,
    });
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return this.workflows.remove(user.organizationId, id);
  }

  /** Inscribe manualmente una conversación en este workflow. */
  @Post(':id/enroll')
  async enroll(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() dto: EnrollDto,
  ) {
    const started = await this.engine.enrollById(user.organizationId, id, dto.conversationId);
    return { started };
  }
}
