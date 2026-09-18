import { GoogleGenAI, Type } from "@google/genai";
import { MemoryService } from "../services/MemoryService";
import { createSemanticMemory } from "../types/Memory";
import { EmotionalProfile } from "./types";

export class EmotionalUnderstandingEngine {
  private ai: GoogleGenAI;
  private memoryService: MemoryService;
  private currentProfile: EmotionalProfile;

  constructor(memoryService: MemoryService) {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.memoryService = memoryService;
    
    // Initialize default profile
    this.currentProfile = {
      valence: 0,
      arousal: 0,
      stressLevel: 0,
      dominantEmotion: 'neutral',
      lastUpdated: Date.now()
    };
  }

  async loadProfile(userId: string = "default_user"): Promise<void> {
    try {
      // Basic retrieval logic assuming memoryService supports get by ID/key, simplified here.
      // In a real implementation this would query the memory store for the latest profile
      const storedProfile = this.memoryService.queryMemories({
        type: "semantic",
        tags: [`emotional_profile_${userId}`],
        limit: 1,
      });
      const latest = storedProfile.memories[0];
      if (latest?.metadata?.profile) {
        this.currentProfile = latest.metadata.profile as EmotionalProfile;
      }
    } catch (e) {
      // Ignored, fallback to default
    }
  }

  async analyzeUserMessage(message: string, userId: string = "default_user"): Promise<EmotionalProfile> {
    const prompt = `Analyze the emotional content of this message: "${message}".
Update the current emotional profile based on this new message.
Current Profile: ${JSON.stringify(this.currentProfile)}`;

    const response = await this.ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: "You are an Emotional Understanding Engine. Return a JSON representing the updated emotional profile (valence [-1 to 1], arousal [-1 to 1], stressLevel [0 to 1], dominantEmotion).",
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            valence: { type: Type.NUMBER },
            arousal: { type: Type.NUMBER },
            stressLevel: { type: Type.NUMBER },
            dominantEmotion: { type: Type.STRING }
          },
          required: ["valence", "arousal", "stressLevel", "dominantEmotion"]
        }
      }
    });

    if (!response.text) throw new Error("Emotional Understanding Engine failed to generate response.");

    const newProfileData = JSON.parse(response.text);
    this.currentProfile = {
      ...newProfileData,
      lastUpdated: Date.now()
    };

    // Save back to memory - simplified
    const profileMemory = createSemanticMemory(
      `emotional_profile_${userId}`,
      "emotional_profile",
      1.0,
      ["emotional_profile", `emotional_profile_${userId}`],
      [JSON.stringify(this.currentProfile)],
    );
    profileMemory.metadata = { key: `emotional_profile_${userId}`, profile: this.currentProfile };
    this.memoryService.storeSemantic(profileMemory);

    return this.currentProfile;
  }

  getCurrentProfile(): EmotionalProfile {
    return this.currentProfile;
  }
}
