import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import { initSqlBridge } from "../../../server_state";
import { MusicAsset } from "./schemas";

export class MusicAssetManager {
  private readonly baseDir: string;

  constructor() {
    this.baseDir = path.resolve(process.cwd(), "data", "projects");
  }

  getAssetPath(projectId: string, assetType: string, extension: string): string {
    const dir = path.join(this.baseDir, projectId, "assets");
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, `${assetType}_${crypto.randomBytes(4).toString("hex")}${extension}`);
  }

  async saveAsset(projectId: string, assetType: string, buffer: Buffer, metadata: any, extension: string): Promise<MusicAsset> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) throw new Error("Database not initialized");

    const filePath = this.getAssetPath(projectId, assetType, extension);
    await fs.writeFile(filePath, buffer);

    const asset: MusicAsset = {
      id: `asset_${crypto.randomUUID()}`,
      project_id: projectId,
      asset_type: assetType,
      file_path: filePath,
      metadata: JSON.stringify(metadata),
      created_at: new Date().toISOString()
    };

    const stmt = bridge.db.prepare(`
      INSERT INTO music_assets (id, project_id, asset_type, file_path, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run([asset.id, asset.project_id, asset.asset_type, asset.file_path, asset.metadata, asset.created_at]);
    stmt.free && stmt.free();
    bridge.persist();

    return asset;
  }

  async getAssetsForProject(projectId: string): Promise<MusicAsset[]> {
    const bridge = await initSqlBridge();
    if (!bridge?.db) return [];

    const res = bridge.db.exec(`SELECT * FROM music_assets WHERE project_id = '${projectId}' ORDER BY created_at ASC`);
    if (!res?.[0]) return [];

    const cols = res[0].columns;
    return res[0].values.map((vals: any[]) => {
      const a: any = {};
      cols.forEach((col: string, i: number) => {
        a[col] = vals[i];
      });
      return a as MusicAsset;
    });
  }
}
