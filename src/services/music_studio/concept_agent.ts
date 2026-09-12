import { GoogleGenAI, Type } from '@google/genai';
import { MusicProjectManager } from './project_manager';

export class ConceptAgent {
  private ai: GoogleGenAI;
  private projectManager: MusicProjectManager;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.projectManager = new MusicProjectManager();
  }

  async generateConcept(projectId: string, prompt: string): Promise<any> {
    const project = await this.projectManager.getProject(projectId);
    if (!project) throw new Error("Project not found");

    const systemInstruction = `You are SARA, an autonomous AI music creator. 
Generate a structured music project concept based on the user's prompt. 
You must also generate a unique 'voice_profile' to ensure originality, completely avoiding impersonation of real artists.`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            concept: { type: Type.STRING },
            genre: { type: Type.STRING },
            mood: { type: Type.STRING },
            language: { type: Type.STRING },
            target_audience: { type: Type.STRING },
            bpm: { type: Type.INTEGER },
            key: { type: Type.STRING },
            time_signature: { type: Type.STRING },
            voice_profile: {
              type: Type.OBJECT,
              properties: {
                gender_presentation: { type: Type.STRING },
                tone: { type: Type.STRING },
                texture: { type: Type.STRING },
                energy: { type: Type.STRING },
                emotion: { type: Type.STRING },
                clarity: { type: Type.STRING },
              },
            },
            instrument_configuration: { type: Type.STRING },
          },
          required: ["title", "concept", "genre", "mood", "language", "target_audience", "bpm", "key", "time_signature", "voice_profile", "instrument_configuration"]
        },
      }
    });

    if (!response.text) throw new Error("Failed to generate concept");
    const conceptData = JSON.parse(response.text);

    const updatedProject = await this.projectManager.updateProject(projectId, {
      title: conceptData.title,
      concept: conceptData.concept,
      genre: conceptData.genre,
      mood: conceptData.mood,
      language: conceptData.language,
      target_audience: conceptData.target_audience,
      bpm: conceptData.bpm,
      key: conceptData.key,
      time_signature: conceptData.time_signature,
      vocal_configuration: JSON.stringify(conceptData.voice_profile),
      instrument_configuration: conceptData.instrument_configuration,
      production_status: "CONCEPT"
    });

    return updatedProject;
  }
}
