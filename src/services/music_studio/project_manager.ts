import { initSqlBridge } from "../../../server_state";
import { MusicProject, MusicProjectStatus } from "./schemas";
import crypto from "crypto";

export class MusicProjectManager {
  
  async createProject(userId: string, title: string = "Untitled Project"): Promise<MusicProject> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) throw new Error("Database not initialized");

    const project: MusicProject = {
      project_id: `music_proj_${crypto.randomUUID()}`,
      user_id: userId,
      title: title,
      concept: "",
      genre: "",
      mood: "",
      language: "",
      target_audience: "",
      lyrics: "",
      composition_metadata: "",
      bpm: 0,
      key: "",
      time_signature: "",
      vocal_configuration: "",
      instrument_configuration: "",
      production_status: "IDEA",
      quality_report: "",
      publishing_status: "DRAFT",
      youtube_metadata: "",
      instagram_metadata: "",
      analytics_summary: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const stmt = bridge.db.prepare(`
      INSERT INTO music_projects (
        project_id, user_id, title, concept, genre, mood, language, target_audience,
        lyrics, composition_metadata, bpm, key, time_signature, vocal_configuration,
        instrument_configuration, production_status, quality_report, publishing_status,
        youtube_metadata, instagram_metadata, analytics_summary, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `);

    stmt.run([
      project.project_id, project.user_id, project.title, project.concept,
      project.genre, project.mood, project.language, project.target_audience,
      project.lyrics, project.composition_metadata, project.bpm, project.key,
      project.time_signature, project.vocal_configuration, project.instrument_configuration,
      project.production_status, project.quality_report, project.publishing_status,
      project.youtube_metadata, project.instagram_metadata, project.analytics_summary,
      project.created_at, project.updated_at
    ]);

    stmt.free && stmt.free();
    bridge.persist();

    return project;
  }

  async getProject(projectId: string): Promise<MusicProject | null> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) return null;

    const stmt = bridge.db.prepare("SELECT * FROM music_projects WHERE project_id = ?");
    stmt.bind([projectId]);
    if (!stmt.step()) { stmt.free?.(); return null; }
    const cols = stmt.getColumnNames();
    const vals = stmt.get();
    stmt.free?.();
    const project: any = {};
    cols.forEach((col: string, i: number) => {
      project[col] = vals[i];
    });

    return project as MusicProject;
  }

  async updateProject(projectId: string, updates: Partial<MusicProject>): Promise<MusicProject | null> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) return null;

    const project = await this.getProject(projectId);
    if (!project) return null;

    const updated = { ...project, ...updates, updated_at: new Date().toISOString() };
    
    const fields = Object.keys(updated);
    const setClause = fields.map(f => `${f} = ?`).join(", ");
    const values = fields.map(f => (updated as any)[f]);

    const stmt = bridge.db.prepare(`UPDATE music_projects SET ${setClause} WHERE project_id = ?`);
    stmt.run([...values, projectId]);
    stmt.free && stmt.free();
    bridge.persist();

    return updated;
  }

  async listProjects(userId: string): Promise<MusicProject[]> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) return [];

    const stmt = bridge.db.prepare("SELECT * FROM music_projects WHERE user_id = ? ORDER BY created_at DESC");
    stmt.bind([userId]);
    const rows: any[][] = [];
    while (stmt.step()) rows.push(stmt.get());
    const cols = stmt.getColumnNames();
    stmt.free?.();
    return rows.map((vals: any[]) => {
      const p: any = {};
      cols.forEach((col: string, i: number) => {
        p[col] = vals[i];
      });
      return p as MusicProject;
    });
  }
}
