import { ConversationRepository } from './ConversationRepository';

export class ConversationTitleService {
  private repository: ConversationRepository;

  constructor() {
    this.repository = new ConversationRepository();
  }

  /**
   * Checks if a title should be generated and runs it asynchronously.
   * Does not block the main execution flow.
   */
  public checkAndGenerateTitle(conversationId: string) {
    // Run asynchronously
    setTimeout(async () => {
      try {
        await this.generateTitle(conversationId);
      } catch (error) {
        console.error(`[ConversationTitleService] Failed to generate title for ${conversationId}:`, error);
      }
    }, 0);
  }

  private async generateTitle(conversationId: string): Promise<void> {
    const conv = await this.repository.findById(conversationId);
    if (!conv) return;

    // Only generate if we have a few messages and title is default
    if (conv.messages.length >= 2 && (conv.title === "SARA Voice Conversation" || conv.title === "New Conversation")) {
      // TODO: Call LLM to generate title from messages.
      // For Phase 2, we just use a placeholder to prove the architecture.
      const firstUserMsg = conv.messages.find(m => m.role === 'user');
      if (firstUserMsg) {
        let snippet = firstUserMsg.content.substring(0, 30);
        if (firstUserMsg.content.length > 30) snippet += "...";
        conv.title = snippet;
        await this.repository.save(conv);
      }
    }
  }
}
