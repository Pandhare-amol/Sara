import { ConversationRecord, ConversationMessage } from '../../../server_state';
import { ConversationRepository } from './ConversationRepository';
import { ConversationTitleService } from './ConversationTitleService';

export class ConversationManager {
  private repository: ConversationRepository;
  private titleService: ConversationTitleService;

  constructor() {
    this.repository = new ConversationRepository();
    this.titleService = new ConversationTitleService();
  }

  async startNewConversation(userId: string = "default-user"): Promise<ConversationRecord> {
    const conv = await this.repository.findOrCreate();
    conv.userId = userId;
    await this.repository.save(conv);
    return conv;
  }

  async addMessage(
    conversationId: string, 
    role: "user" | "assistant" | "system" | "agent" | "tool", 
    content: string, 
    metadata?: Record<string, unknown>
  ): Promise<ConversationMessage> {
    const msg: ConversationMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      conversationId,
      role,
      content,
      timestamp: new Date().toISOString(),
      metadata
    };
    
    await this.repository.appendMessage(msg);
    
    // Generate title asynchronously if early in conversation
    if (role === 'user') {
      this.titleService.checkAndGenerateTitle(conversationId);
    }
    
    return msg;
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    return await this.repository.findById(id);
  }

  async getAllConversations(): Promise<ConversationRecord[]> {
    return await this.repository.findAll();
  }
}
