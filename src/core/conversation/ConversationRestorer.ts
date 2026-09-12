import { ConversationRepository } from './ConversationRepository';
import { getSessionRecoveryContext, getConversationTaskContext } from '../../../server_state';

export interface RestoredContext {
  conversationId: string;
  summary: string;
  activeContext: Record<string, unknown>;
  taskState: Record<string, unknown>;
  recentMessages: any[]; // Using any to avoid complex type export matching here
  taskId?: string;
  status?: string;
  session?: any;
}

export class ConversationRestorer {
  private repository: ConversationRepository;

  constructor() {
    this.repository = new ConversationRepository();
  }

  async restoreConversationContext(conversationId: string): Promise<RestoredContext | null> {
    const conv = await this.repository.findById(conversationId);
    if (!conv) return null;

    // Load recent messages (last 20 for context)
    const recentMessages = conv.messages.slice(-20);

    // Load task context
    const taskContext = await getConversationTaskContext(conversationId);
    
    // Load session recovery context
    const sessionRecovery = await getSessionRecoveryContext(conversationId);

    return {
      conversationId: conv.id,
      summary: taskContext?.summary || conv.summary || "Previous conversation context.",
      activeContext: taskContext?.activeContext || conv.activeContext || {},
      taskState: taskContext?.taskState || conv.taskState || {},
      recentMessages,
      taskId: taskContext?.taskId,
      status: taskContext?.status,
      session: sessionRecovery?.session
    };
  }
}
