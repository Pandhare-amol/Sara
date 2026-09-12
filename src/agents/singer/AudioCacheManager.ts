import fs from "node:fs";
import path from "node:path";

export class AudioCacheManager {
  constructor(private readonly directory = path.resolve(process.cwd(), "data", "singer-cache"), private readonly maxBytes = 250 * 1024 * 1024) {
    fs.mkdirSync(this.directory, { recursive: true });
  }
  getDirectory(): string { return this.directory; }
  async enforceLimit(): Promise<void> {
    const entries = fs.readdirSync(this.directory).map((name) => {
      const filePath = path.join(this.directory, name);
      const stat = fs.statSync(filePath);
      return { filePath, size: stat.size, mtime: stat.mtimeMs };
    }).filter((entry) => fs.statSync(entry.filePath).isFile()).sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      try { fs.unlinkSync(entry.filePath); total -= entry.size; } catch { /* best effort cleanup */ }
    }
  }
  removeTemporary(filePath: string): void {
    if (!path.resolve(filePath).startsWith(path.resolve(this.directory))) return;
    try { fs.unlinkSync(filePath); } catch { /* already absent */ }
  }
}
