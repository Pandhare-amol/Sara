import { IntentEngine, ParsedIntent } from './IntentEngine';
import { createTask } from '../../../server_state';
import { initTaskRunner } from '../../../server_task_manager';

export interface CoreResponse {
  type: 'task_queued' | 'chat_response' | 'system_response';
  message: string;
  taskId?: string;
  parsedIntent?: ParsedIntent;
}

export class SaraCore {
  private intentEngine: IntentEngine;

  constructor() {
    this.intentEngine = new IntentEngine();
  }

  /**
   * Process a natural language request from the user.
   */
  public async processRequest(conversationId: string, input: string, activeContext?: Record<string, unknown>): Promise<CoreResponse> {
    console.log(`[SaraCore] Processing input: "${input}"`);
    
    // 1. Parse Intent
    const parsed = await this.intentEngine.parseIntent(input, activeContext);
    console.log(`[SaraCore] Parsed Intent:`, parsed);

    // 2. Route based on intent
    if (parsed.intent === 'task' || parsed.intent === 'search') {
      // Create a background task for the execution engine (TaskRunner)
      const task = await createTask({
        conversationId,
        description: parsed.goal,
        priority: 5,
        metadata: {
          parsedIntent: parsed,
          source: 'natural_language',
          automation: false
        }
      });
      
      // Wake up the task runner to process the new task
      const runner = initTaskRunner();
      runner.wake();

      return {
        type: 'task_queued',
        taskId: task.taskId,
        message: `I've queued a task to ${parsed.goal}.`,
        parsedIntent: parsed
      };
    } else if (parsed.intent === 'system') {
      return {
        type: 'system_response',
        message: "Processing system command...",
        parsedIntent: parsed
      };
    } else {
      // chat
      // Fallback for chat is generally just returning what to say
      // A more complex system would pipe this to a conversational agent
      return {
        type: 'chat_response',
        message: "Chat intent recognized.",
        parsedIntent: parsed
      };
    }
  }
}
