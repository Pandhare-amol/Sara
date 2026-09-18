import { GoogleGenAI, Type } from "@google/genai";
import { MemoryService } from "../services/MemoryService";
import { getEpisodicMemory } from "../cognitive/episodicMemory";
import { ASIQuery, ASIResponse } from "./types";

export class CognitiveSuperiorityEngine {
  private ai: GoogleGenAI;
  private memoryService: MemoryService;

  constructor(memoryService: MemoryService, apiKey = process.env.GEMINI_API_KEY || "") {
    this.ai = new GoogleGenAI({ apiKey });
    this.memoryService = memoryService;
  }

  async processQuery(query: ASIQuery): Promise<ASIResponse> {
    const startTime = Date.now();
    const episodicMemory = getEpisodicMemory();
    
    // 1. Retrieve memories as context
    const recentEpisodes = episodicMemory.list(10);
    const contextStr = recentEpisodes.map(ep => ep.title).join(", ");

    // 2. Multi-domain meta-prompt
    const systemInstruction = `You are SARA's bounded advanced reasoning engine. Do not claim superintelligence, certainty, consciousness, or independent authority.
  Synthesize evidence across multiple domains while clearly separating facts, assumptions, hypotheses, and evidence gaps.
Your current domains of focus: ${query.domains.join(", ")}.
Reason deeply at level ${query.depthLevel} out of 5 (where 5 is maximum depth).
  Provide cross-domain links and hypotheses, not unverified facts.
Analyze the problem from the perspective of each domain and then combine them for a superior solution.`;

    const prompt = `Query: ${query.question}\nRecent Context: ${contextStr}`;

    const response = await this.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            confidence: { type: Type.NUMBER },
            novelInsights: { type: Type.ARRAY, items: { type: Type.STRING } },
            crossDomainLinks: { 
              type: Type.ARRAY, 
              items: { 
                type: Type.OBJECT,
                properties: {
                  domainA: { type: Type.STRING },
                  domainB: { type: Type.STRING },
                  link: { type: Type.STRING }
                }
              }
            },
            proposedNextSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
            reasoningTrace: { type: Type.ARRAY, items: { type: Type.STRING } }
            ,assumptions: { type: Type.ARRAY, items: { type: Type.STRING } }
            ,risks: { type: Type.ARRAY, items: { type: Type.STRING } }
            ,evidenceGaps: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["answer", "confidence", "novelInsights", "crossDomainLinks", "proposedNextSteps", "reasoningTrace"]
        }
      }
    });

    if (!response.text) throw new Error("Cognitive Superiority Engine failed to generate response.");
    
    const data = JSON.parse(response.text) as ASIResponse;
    data.confidence = Math.max(0, Math.min(1, Number(data.confidence) || 0));
    data.assumptions = Array.isArray(data.assumptions) ? data.assumptions : [];
    data.risks = Array.isArray(data.risks) ? data.risks : [];
    data.evidenceGaps = Array.isArray(data.evidenceGaps) ? data.evidenceGaps : [];
    data.processingTimeMs = Date.now() - startTime;

    // Track reasoning in episodic memory
    episodicMemory.record({
      title: `ASI Query: ${query.question.substring(0, 50)}`,
      context: {
        goal: 'ASI Processing',
        environment: 'CognitiveSuperiorityEngine',
        initialState: query
      },
      plan: { steps: [] },
      execution: { actions: [], observations: [] },
      outcome: {
        success: true,
        goalAchieved: true,
        completionTime: data.processingTimeMs,
        userIntervention: false
      },
      lesson: {
        keyInsights: data.novelInsights
      },
      metadata: {
        importance: query.depthLevel / 5,
        confidence: data.confidence
      }
    });

    return data;
  }
}
