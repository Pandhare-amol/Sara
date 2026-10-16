import type { Memory } from "../lib/memoryTypes";

export interface MemoryExportDocument {
  format: "sara-personal-memory";
  version: 1;
  exportedAt: string;
  memories: Memory[];
}

export function serializeMemoryExport(memories: Memory[], exportedAt = new Date().toISOString()): string {
  const document: MemoryExportDocument = {
    format: "sara-personal-memory",
    version: 1,
    exportedAt,
    memories,
  };
  return JSON.stringify(document, null, 2);
}
