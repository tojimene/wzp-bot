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
import { TagsService } from './tags.service';
import { ApplyTagDto, CreateTagDto, UpdateTagDto } from './dto/tags.dto';

@Controller('tags')
@UseGuards(AuthGuard)
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  // --- Catálogo ---------------------------------------------------------------

  @Get()
  list(@CurrentUser() user: AuthContext) {
    return this.tags.listDefinitions(user.organizationId);
  }

  @Post()
  create(@CurrentUser() user: AuthContext, @Body() dto: CreateTagDto) {
    return this.tags.createDefinition(user.organizationId, user.userId, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthContext,
    @Param('id') id: string,
    @Body() dto: UpdateTagDto,
  ) {
    return this.tags.updateDefinition(user.organizationId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthContext, @Param('id') id: string) {
    return this.tags.removeDefinition(user.organizationId, id);
  }

  // --- Etiquetas por conversación (manual) ------------------------------------

  @Get('conversations/:conversationId')
  forConversation(
    @CurrentUser() user: AuthContext,
    @Param('conversationId') conversationId: string,
  ) {
    return this.tags.tagsForConversation(user.organizationId, conversationId);
  }

  @Post('conversations/:conversationId')
  add(
    @CurrentUser() user: AuthContext,
    @Param('conversationId') conversationId: string,
    @Body() dto: ApplyTagDto,
  ) {
    return this.tags.addTagManual(user.organizationId, conversationId, dto.tagId, user.userId);
  }

  @Delete('conversations/:conversationId/:tagId')
  removeFromConversation(
    @CurrentUser() user: AuthContext,
    @Param('conversationId') conversationId: string,
    @Param('tagId') tagId: string,
  ) {
    return this.tags.removeTagManual(user.organizationId, conversationId, tagId, user.userId);
  }
}
