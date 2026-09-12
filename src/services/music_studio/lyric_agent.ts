import { GoogleGenAI, Type } from '@google/genai';
import { MusicProjectManager } from './project_manager';

export class LyricAgent {
  private ai: GoogleGenAI;
  private projectManager: MusicProjectManager;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this.projectManager = new MusicProjectManager();
  }

  async generateLyrics(projectId: string, instructions?: string): Promise<any> {
    const project = await this.projectManager.getProject(projectId);
    if (!project) throw new Error("Project not found");

    const systemInstruction = `You are SARA, an autonomous AI music creator. 
Write original, highly structured lyrics based on the provided concept. 
Ensure the lyrics match the theme, genre, mood, and language. 
Structure the song correctly (e.g., Verse, Chorus, Bridge). Do NOT use excessive repetition.`;

    const prompt = `
Project Concept:
Title: ${project.title}
Concept: ${project.concept}
Genre: ${project.genre}
Mood: ${project.mood}
Language: ${project.language}
Target Audience: ${project.target_audience}
Previous Lyrics: ${project.lyrics || 'None'}

User Instructions for this revision/generation:
${instructions || 'Generate full structured lyrics for this concept.'}
`;

    const response = await this.ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            lyrics: { type: Type.STRING, description: "The complete structured lyrics" },
            structure_explanation: { type: Type.STRING, description: "Explanation of the chosen song structure" }
          },
          required: ["lyrics", "structure_explanation"]
        },
      }
    });

    if (!response.text) throw new Error("Failed to generate lyrics");
    const lyricData = JSON.parse(response.text);

    // Save previous version if exists (basic versioning in metadata for now)
    let compositionMetadata = {};
    try {
      compositionMetadata = project.composition_metadata ? JSON.parse(project.composition_metadata) : {};
    } catch {}

    const versions = (compositionMetadata as any).lyric_versions || [];
    if (project.lyrics) {
      versions.push({
        version: versions.length + 1,
        lyrics: project.lyrics,
        archived_at: new Date().toISOString()
      });
    }
    
    (compositionMetadata as any).lyric_versions = versions;
    (compositionMetadata as any).structure_explanation = lyricData.structure_explanation;

    const updatedProject = await this.projectManager.updateProject(projectId, {
      lyrics: lyricData.lyrics,
      composition_metadata: JSON.stringify(compositionMetadata),
      production_status: "LYRICS"
    });

    return updatedProject;
  }
}
