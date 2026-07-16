import { Module } from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { MessagingModule } from '../messaging/messaging.module';
import { SetterModule } from '../setter/setter.module';
import { TagsModule } from '../tags/tags.module';
import { ConversationAnalysisService } from './conversation-analysis.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';

@Module({
  imports: [MessagingModule, SetterModule, TagsModule],
  controllers: [InboxController],
  providers: [InboxService, ConversationAnalysisService, AuthGuard],
})
export class InboxModule {}
