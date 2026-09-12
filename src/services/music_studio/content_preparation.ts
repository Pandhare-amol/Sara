import { MusicAssetManager } from "./asset_manager";
import { MusicProjectManager } from "./project_manager";
import { MusicQualityAnalyzer, type QualityReport } from "./quality_analyzer";

export interface PlatformDraft {
  platform: "youtube" | "instagram";
  title: string;
  description: string;
  tags: string[];
  privacy?: "private" | "unlisted" | "public";
  format?: "16:9" | "9:16" | "1:1";
  requiresApproval: boolean;
}

export interface PublishingReadiness {
  projectId: string;
  ready: boolean;
  approvalRequired: boolean;
  approved: boolean;
  videoAsset?: string;
  checks: Array<{ name: string; passed: boolean; details: string }>;
  drafts: PlatformDraft[];
}

export class MusicContentPreparationService {
  private readonly projects = new MusicProjectManager();
  private readonly assets = new MusicAssetManager();
  private readonly quality = new MusicQualityAnalyzer();

  async prepare(projectId: string): Promise<PublishingReadiness> {
    const project = await this.projects.getProject(projectId);
    if (!project) throw new Error("Music project not found.");
    const assets = await this.assets.getAssetsForProject(projectId);
    const video = assets.filter((asset) => asset.asset_type === "video" || asset.asset_type === "final_video").at(-1);
    const checks: PublishingReadiness["checks"] = [{ name: "project_exists", passed: true, details: project.project_id }];
    let quality: QualityReport | null = null;
    if (video) {
      quality = await this.quality.verifyProjectAsset(projectId, video.file_path);
      checks.push(...quality.checks);
    } else {
      checks.push({ name: "verified_video_asset", passed: false, details: "No verified final video asset is available." });
    }
    const metadata = this.parse(project.youtube_metadata);
    const approved = metadata.approval?.approved === true;
    const drafts = this.buildDrafts(project, metadata);
    await this.projects.updateProject(projectId, {
      youtube_metadata: JSON.stringify({ ...metadata, drafts, readiness: { checks, prepared_at: new Date().toISOString() } }),
      instagram_metadata: JSON.stringify({ platform: "instagram", drafts: drafts.filter((draft) => draft.platform === "instagram") }),
      publishing_status: approved ? "APPROVED" : "USER_APPROVAL",
    });
    return { projectId, ready: Boolean(video && quality?.passed && approved), approvalRequired: true, approved, videoAsset: video?.file_path, checks, drafts };
  }

  async approve(projectId: string, approvedBy: string): Promise<PublishingReadiness> {
    const project = await this.projects.getProject(projectId);
    if (!project) throw new Error("Music project not found.");
    const metadata = this.parse(project.youtube_metadata);
    await this.projects.updateProject(projectId, {
      youtube_metadata: JSON.stringify({ ...metadata, approval: { approved: true, approved_by: approvedBy, approved_at: new Date().toISOString() } }),
      publishing_status: "APPROVED",
    });
    return this.prepare(projectId);
  }

  private buildDrafts(project: { title: string; concept: string; genre: string; mood: string; language: string; target_audience: string }, metadata: Record<string, any>): PlatformDraft[] {
    const title = project.title || "Untitled SARA Music Project";
    const description = `${project.concept || `An original ${project.mood || "emotional"} ${project.genre || "music"} creation by SARA.`}\n\nLanguage: ${project.language || "unspecified"}\nAudience: ${project.target_audience || "listeners"}\n\nOriginal synthetic SARA creation. No real-person voice imitation.`;
    const tags = [project.genre, project.mood, project.language, "SARA", "original music"].filter(Boolean).map((tag) => tag.toLowerCase().replace(/\s+/g, "-"));
    return [
      { platform: "youtube", title, description, tags, privacy: metadata.privacy || "private", format: "16:9", requiresApproval: true },
      { platform: "instagram", title, description, tags, format: "9:16", requiresApproval: true },
    ];
  }

  private parse(raw: string): Record<string, any> { try { return raw ? JSON.parse(raw) : {}; } catch { return {}; } }
}

export const musicContentPreparation = new MusicContentPreparationService();
