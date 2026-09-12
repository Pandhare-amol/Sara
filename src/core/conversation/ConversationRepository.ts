import {
  getConversation,
  getOrCreateConversation,
  loadConversations,
  saveConversations,
  appendConversationMessage,
  ConversationRecord,
  ConversationMessage
} from '../../../server_state';

export interface IConversationRepository {
  findById(id: string): Promise<ConversationRecord | null>;
  findOrCreate(id?: string): Promise<ConversationRecord>;
  findAll(): Promise<ConversationRecord[]>;
  save(conversation: ConversationRecord): Promise<void>;
  appendMessage(message: ConversationMessage): Promise<void>;
  deleteById(id: string): Promise<boolean>;
}

export class ConversationRepository implements IConversationRepository {
  async findById(id: string): Promise<ConversationRecord | null> {
    return await getConversation(id);
  }

  async findOrCreate(id?: string): Promise<ConversationRecord> {
    return await getOrCreateConversation(id);
  }

  async findAll(): Promise<ConversationRecord[]> {
    return await loadConversations();
  }

  async save(conversation: ConversationRecord): Promise<void> {
    const all = await loadConversations();
    const index = all.findIndex(c => c.id === conversation.id);
    if (index >= 0) {
      all[index] = conversation;
    } else {
      all.push(conversation);
    }
    await saveConversations(all);
  }

  async appendMessage(message: ConversationMessage): Promise<void> {
    await appendConversationMessage(message);
  }

  async deleteById(id: string): Promise<boolean> {
    const all = await loadConversations();
    const filtered = all.filter(c => c.id !== id);
    if (filtered.length !== all.length) {
      await saveConversations(filtered);
      return true;
    }
    return false;
  }
}
