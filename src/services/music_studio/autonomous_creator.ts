import { ConceptAgent } from "./concept_agent";
import { LyricAgent } from "./lyric_agent";
import { MusicProjectManager } from "./project_manager";
import { MusicProviderError, musicProviderRegistry } from "./provider_registry";
import { MusicWorkflowStore } from "./workflow_store";
import type { CreativeBrief, MusicWorkflowTask } from "./autonomousTypes";

export class AutonomousMusicCreator {
  private readonly projects = new MusicProjectManager();
  private readonly workflows = new MusicWorkflowStore();
  private readonly concepts = new ConceptAgent();
  private readonly lyrics = new LyricAgent();

  async create(input: { userId: string; conversationId?: string; prompt: string; brief?: Partial<CreativeBrief> }): Promise<{ project: Awaited<ReturnType<MusicProjectManager["createProject"]>>; workflow: MusicWorkflowTask }> {
    const project = await this.projects.createProject(input.userId, input.brief?.theme || "Untitled Project");
    const brief: CreativeBrief = {
      theme: input.brief?.theme || input.prompt,
      genre: input.brief?.genre || "pop",
      mood: input.brief?.mood || "emotional",
      language: input.brief?.language || "English",
      targetAudience: input.brief?.targetAudience || "general listeners",
      duration: input.brief?.duration || "SHORT",
      energyLevel: input.brief?.energyLevel ?? 0.5,
      vocalStyle: input.brief?.vocalStyle || "original warm expressive SARA vocal persona",
      referenceCharacteristics: input.brief?.referenceCharacteristics || [],
    };
    await this.projects.updateProject(project.project_id, { composition_metadata: JSON.stringify({ creative_brief: brief, source_prompt: input.prompt }) });
    const workflow = await this.workflows.create({ projectId: project.project_id, conversationId: input.conversationId });
    return { project: (await this.projects.getProject(project.project_id)) || project, workflow };
  }

  async execute(workflowTaskId: string): Promise<MusicWorkflowTask> {
    let task = await this.workflows.get(workflowTaskId);
    if (!task) throw new Error("Music workflow task not found.");
    const project = await this.projects.getProject(task.projectId);
    if (!project) throw new Error("Music project not found.");
    try {
      task = await this.advance(task, "CONCEPT", "Creating structured song concept", 15);
      const metadata = this.parseMetadata(project.composition_metadata);
      if (!metadata.concept_completed) {
        await this.concepts.generateConcept(project.project_id, String(metadata.source_prompt || project.concept));
        await this.projects.updateProject(project.project_id, { composition_metadata: JSON.stringify({ ...metadata, concept_completed: true }) });
      }
      task = (await this.workflows.get(workflowTaskId))!;
      task = await this.advance(task, "LYRICS", "Writing structured original lyrics", 30);
      const refreshed = await this.projects.getProject(project.project_id);
      const refreshedMetadata = this.parseMetadata(refreshed?.composition_metadata);
      if (!refreshedMetadata.lyrics_completed) {
        await this.lyrics.generateLyrics(project.project_id);
        await this.projects.updateProject(project.project_id, { composition_metadata: JSON.stringify({ ...refreshedMetadata, lyrics_completed: true }) });
      }
      task = (await this.workflows.get(workflowTaskId))!;
      await this.advance(task, "MUSIC_GENERATION", "Waiting for configured music provider", 40);
      const latest = await this.projects.getProject(project.project_id);
      const latestBrief = this.parseMetadata(latest?.composition_metadata).creative_brief as CreativeBrief;
      const provider = musicProviderRegistry.get();
      await provider.generateMusic({ projectId: project.project_id, brief: latestBrief, lyrics: latest?.lyrics || "", compositionPlan: this.parseMetadata(latest?.composition_metadata) });
      return (await this.workflows.update(workflowTaskId, { stage: "QUALITY_CHECK", status: "VERIFYING", progress: 80, currentStep: "Verifying generated music" }))!;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof MusicProviderError ? error.code : "MUSIC_WORKFLOW_FAILED";
      const failed = await this.workflows.update(workflowTaskId, { status: "FAILED", error: { code, message, retryable: error instanceof MusicProviderError && error.retryable }, currentStep: "Workflow failed" });
      if (!failed) throw error;
      return failed;
    }
  }

  async get(workflowTaskId: string): Promise<MusicWorkflowTask | null> { return this.workflows.get(workflowTaskId); }
  async getByProject(projectId: string): Promise<MusicWorkflowTask | null> { return this.workflows.getByProject(projectId); }
  private async advance(task: MusicWorkflowTask, stage: MusicWorkflowTask["stage"], currentStep: string, progress: number): Promise<MusicWorkflowTask> { return (await this.workflows.update(task.taskId, { stage, status: "RUNNING", currentStep, progress }))!; }
  private parseMetadata(raw?: string): Record<string, any> { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
}

export const autonomousMusicCreator = new AutonomousMusicCreator();

export async function executeMusicWorkflowTask(workflowTaskId: string): Promise<MusicWorkflowTask> {
  return autonomousMusicCreator.execute(workflowTaskId);
}
