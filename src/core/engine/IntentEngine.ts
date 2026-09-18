import { GoogleGenAI, Type, Schema } from '@google/genai';
import { memoryService } from '../../services/MemoryService';

export interface ParsedIntent {
  intent: 'chat' | 'task' | 'search' | 'system';
  goal: string;
  context_references: string[];
  suggested_agent?: string;
  parameters: Record<string, unknown>;
  confidence: number;
}

export class IntentEngine {
  private ai: GoogleGenAI;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
      console.warn("IntentEngine initialized without valid GEMINI_API_KEY.");
    }
    this.ai = new GoogleGenAI({ apiKey: apiKey || 'MY_GEMINI_API_KEY', httpOptions: { headers: { 'User-Agent': 'sara-intent-engine' } } });
  }

  public async parseIntent(input: string, activeContext?: Record<string, unknown>): Promise<ParsedIntent> {
    // Retrieve relevant memories to provide context for intent parsing
    const memoryResult = memoryService.queryMemories({ keywords: input.split(/\s+/).filter(Boolean), limit: 5, confidence: 0.5 });
    const memorySummary = memoryResult.memories.map(m => `- ${m.type} memory (id=${m.id}): ${JSON.stringify(m)}`).join('\n');
    const memorySection = memorySummary ? `Relevant memories:\n${memorySummary}\n\n` : '';
    const prompt = `${memorySection}You are the Intent Engine for SARA, a personal AI operating assistant.
Your job is to analyze the user's natural language input and extract their exact intent.

User Input: "${input}"
Active Context: ${activeContext ? JSON.stringify(activeContext) : 'None'}

Determine the intent category:
- 'chat': The user is just conversing, greeting, or asking a general knowledge question that requires no OS/tool action.
- 'task': The user is asking you to DO something (e.g., "open notepad", "delete a file", "play a song", "turn off the PC", "run a script").
- 'search': The user is explicitly asking to search the web or find information online (e.g., "look up the weather", "search google for X")).
- 'system': The user is asking about SARA's own status, settings, or stopping a current task (e.g., "stop", "what are you doing?"))

Extract any context references (e.g. if they say "open that file", the context reference is "that file", which needs resolution).
Return a JSON object matching the required schema.
`;

    const schema: Schema = {
      type: Type.OBJECT,
      properties: {
        intent: { type: Type.STRING, enum: ['chat', 'task', 'search', 'system'] },
        goal: { type: Type.STRING, description: "A clear, actionable statement of what the user wants." },
        context_references: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Ambiguous pronouns or references like 'that file', 'it', 'this window'." },
        suggested_agent: { type: Type.STRING, description: "E.g., browser_agent, os_agent, desktop_agent, coding_agent. Optional." },
        parameters: { type: Type.OBJECT, description: "Any extracted named parameters, like file names, URLs, search queries." },
        confidence: { type: Type.NUMBER, description: "0.0 to 1.0 confidence score." }
      },
      required: ['intent', 'goal', 'context_references', 'parameters', 'confidence']
    };

    try {
      const response = await this.ai.models.generateContent({
        model: 'gemini-3.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      });

      const text = response.text?.trim();
      if (!text) throw new Error("Empty response from model");
      
      return JSON.parse(text) as ParsedIntent;
    } catch (e) {
      console.error("[IntentEngine] Failed to parse intent", e);
      // Fallback
      return {
        intent: 'chat',
        goal: input,
        context_references: [],
        parameters: {},
        confidence: 0.1
      };
    }
  }
}
